"""Verlauf: was die Automaten wirklich ausgegeben haben – Grundlage der Schnauz-Analyse.

Die Geräte melden nach jeder Ausgabe DP 14 `feed_report` (Anzahl Portionen) und nach jeder Planänderung
DP 1 `meal_plan`. Beides steht im Tuya-Cloud-Log, das aber nicht ewig aufbewahrt wird. Deshalb wird es
regelmässig in history.db (SQLite) übernommen. Ausgesetzte Mahlzeiten meldet das Gerät nicht – die trägt
server.py selbst ein, sobald eine Aussetzung abgelaufen ist.

    .venv/bin/python history.py        # einmal synchronisieren und Tagessummen ausgeben
"""

import sqlite3
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

import tinytuya

from feeder import Meal, decode_plan, load_devices

DB_FILE = Path(__file__).with_name("history.db")
FIRST_SYNC_DAYS = 30  # so weit zurück wird beim allerersten Mal gefragt (die Cloud hat meist weniger)
SYNC_OVERLAP = 3600  # Sekunden – Einträge kommen in der Cloud manchmal verspätet an
MATCH_WINDOW = 3  # Minuten Abstand zur Planzeit, ab dem eine Ausgabe als „extra“ gilt


def db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_FILE)
    con.executescript("""
        CREATE TABLE IF NOT EXISTS feed (feeder TEXT, ts REAL, portions INTEGER, PRIMARY KEY (feeder, ts));
        CREATE TABLE IF NOT EXISTS plan (feeder TEXT, ts REAL, value TEXT, PRIMARY KEY (feeder, ts));
        CREATE TABLE IF NOT EXISTS skip (feeder TEXT, ts REAL, portions INTEGER, PRIMARY KEY (feeder, ts));
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT);
    """)
    return con


def sync(cloud: tinytuya.Cloud) -> int:
    """Holt neue feed_report- und meal_plan-Einträge aus dem Cloud-Log. Gibt die Anzahl neuer Ausgaben zurück."""
    new = 0
    with db() as con:
        for key, cfg in load_devices().items():
            last = con.execute("SELECT value FROM meta WHERE key = ?", (f"synced|{key}",)).fetchone()
            start = float(last[0]) - SYNC_OVERLAP if last else time.time() - FIRST_SYNC_DAYS * 86400
            now = time.time()
            res = cloud.getdevicelog(cfg["id"], start=int(start), end=int(now), evtype="7",
                                     params={"codes": "feed_report,meal_plan"})
            if "result" not in res:
                raise RuntimeError(f"Cloud-Log für {key} fehlgeschlagen: {res}")
            for item in res["result"].get("logs", []):
                ts = item["event_time"] / 1000
                if item["code"] == "feed_report" and int(item["value"]) > 0:
                    cur = con.execute("INSERT OR IGNORE INTO feed VALUES (?, ?, ?)", (key, ts, int(item["value"])))
                    new += cur.rowcount
                elif item["code"] == "meal_plan":
                    con.execute("INSERT OR IGNORE INTO plan VALUES (?, ?, ?)", (key, ts, item["value"]))
            con.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (f"synced|{key}", str(now)))
        con.execute("INSERT OR REPLACE INTO meta VALUES ('synced', ?)", (str(time.time()),))
    return new


def last_sync() -> float:
    with db() as con:
        row = con.execute("SELECT value FROM meta WHERE key = 'synced'").fetchone()
    return float(row[0]) if row else 0.0


def record_skip(feeder: str, at: datetime, portions: int) -> None:
    with db() as con:
        con.execute("INSERT OR IGNORE INTO skip VALUES (?, ?, ?)", (feeder, at.timestamp(), portions))


def load_settings() -> dict[str, str]:
    """Einstellungen aus der App (z. B. Futterpreis). Fehlende Werte ergänzt server.py mit Standardwerten."""
    with db() as con:
        return dict(con.execute("SELECT key, value FROM setting").fetchall())


def save_settings(values: dict[str, str]) -> None:
    with db() as con:
        con.executemany("INSERT OR REPLACE INTO setting VALUES (?, ?)", values.items())


def _minutes(m: Meal) -> int:
    return m.hour * 60 + m.minute


def _plan_at(snapshots: list[tuple[float, list[Meal]]], ts: float, fallback: list[Meal]) -> list[Meal]:
    """Plan, der zum Zeitpunkt ts galt (ohne Snapshot davor: der älteste bekannte)."""
    before = [meals for t, meals in snapshots if t <= ts]
    if before:
        return before[-1]
    return snapshots[0][1] if snapshots else fallback


def analysis(days: int, current: dict[str, list[Meal]]) -> dict:
    """Tagessummen und Einzelereignisse der letzten `days` Tage, alles in Portionen.

    Eine Ausgabe gilt als „laut Plan“, wenn sie höchstens MATCH_WINDOW Minuten nach einer Mahlzeit des damals
    gültigen Plans kommt (pro Mahlzeit und Tag nur einmal). Alles andere ist „extra“ (von Hand gefüttert).
    """
    today = date.today()
    first_day = today - timedelta(days=days - 1)
    since = datetime.combine(first_day, datetime.min.time()).timestamp()
    with db() as con:
        feeds = con.execute("SELECT feeder, ts, portions FROM feed WHERE ts >= ? ORDER BY ts", (since,)).fetchall()
        skips = con.execute("SELECT feeder, ts, portions FROM skip WHERE ts >= ? ORDER BY ts", (since,)).fetchall()
        plans = con.execute("SELECT feeder, ts, value FROM plan ORDER BY ts").fetchall()
        oldest = con.execute("SELECT MIN(ts) FROM feed").fetchone()[0]

    snapshots: dict[str, list[tuple[float, list[Meal]]]] = defaultdict(list)
    for feeder, ts, value in plans:
        try:
            snapshots[feeder].append((ts, decode_plan(value)))
        except ValueError:  # leerer Plan meldet sich als "AA==" (ein Null-Byte)
            snapshots[feeder].append((ts, []))

    events = []
    matched: set[tuple[str, str, int]] = set()  # (feeder, Tag, Planminute) schon bedient
    for feeder, ts, portions in feeds:
        at = datetime.fromtimestamp(ts)
        minute = at.hour * 60 + at.minute
        meals = _plan_at(snapshots[feeder], ts, current.get(feeder, []))
        slot = next((_minutes(m) for m in meals if 0 <= minute - _minutes(m) <= MATCH_WINDOW
                     and (feeder, at.date().isoformat(), _minutes(m)) not in matched), None)
        if slot is not None:
            matched.add((feeder, at.date().isoformat(), slot))
        events.append({"feeder": feeder, "ts": at.isoformat(), "portions": portions, "extra": slot is None})
    skipped = [{"feeder": f, "ts": datetime.fromtimestamp(ts).isoformat(), "portions": p} for f, ts, p in skips]

    keys = list(load_devices())
    per_day = {(first_day + timedelta(days=i)).isoformat(): {k: {"portions": 0, "extra": 0, "skipped": 0} for k in keys}
               for i in range(days)}
    for e in events:
        bucket = per_day[e["ts"][:10]][e["feeder"]]
        bucket["portions"] += e["portions"]
        if e["extra"]:
            bucket["extra"] += e["portions"]
    for s in skipped:
        per_day[s["ts"][:10]][s["feeder"]]["skipped"] += s["portions"]

    return {
        "days": [{"date": d, "feeders": v} for d, v in per_day.items()],
        "events": events,
        "skips": skipped,
        "since": datetime.fromtimestamp(oldest).date().isoformat() if oldest else None,
        "syncedAt": datetime.fromtimestamp(last_sync()).isoformat() if last_sync() else None,
    }


if __name__ == "__main__":
    print(f"{sync(tinytuya.Cloud())} neue Ausgaben übernommen")
    for day in analysis(14, {})["days"]:
        print(day["date"], "  ".join(f"{k}: {v['portions']} (+{v['extra']} extra, {v['skipped']} ausgesetzt)"
                                     for k, v in day["feeders"].items()))
