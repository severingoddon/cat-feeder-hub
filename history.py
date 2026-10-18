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
        CREATE TABLE IF NOT EXISTS supply (id INTEGER PRIMARY KEY, kind TEXT, ts REAL, grams INTEGER, arrived REAL);
    """)
    # ältere history.db ohne Spalte „arrived“ nachrüsten
    if "arrived" not in [row[1] for row in con.execute("PRAGMA table_info(supply)")]:
        con.execute("ALTER TABLE supply ADD COLUMN arrived REAL")
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


# ---------- Vorrat & Bestellungen ----------
# kind = "order": bestellt am ts, erhöht den Vorrat um grams, sobald die Lieferung da ist – bestätigt mit
#   „Ist angekommen“ (arrived), sonst geschätzt DELIVERY_DAYS nach der Bestellung.
# kind = "stock": Vorrat von Hand gezählt – setzt den Stand zum Zeitpunkt ts absolut auf grams.

DELIVERY_DAYS = 3
REMINDER_DAYS = 7  # so lange vor dem Auslaufen erscheint die Erinnerung (Puffer für längere Lieferfristen)


def add_supply(kind: str, ts: float, grams: int) -> int:
    with db() as con:
        return con.execute("INSERT INTO supply (kind, ts, grams) VALUES (?, ?, ?)", (kind, ts, grams)).lastrowid


def confirm_arrival(entry_id: int, ts: float) -> bool:
    with db() as con:
        return con.execute("UPDATE supply SET arrived = ? WHERE id = ? AND kind = 'order'", (ts, entry_id)).rowcount > 0


def delete_supply(entry_id: int) -> bool:
    with db() as con:
        return con.execute("DELETE FROM supply WHERE id = ?", (entry_id,)).rowcount > 0


def supply(rate: float, grams_per_portion: int) -> dict:
    """Vorrat jetzt und Hochrechnung, wann er ausgeht. rate = erwarteter Verbrauch in g pro Tag.

    Ausgangspunkt ist der letzte gezählte Vorrat; ohne Zählung beginnt die Rechnung bei der ersten Bestellung mit 0 g.
    Dazu kommen alle Lieferungen, die danach angekommen sind, minus alles, was die Automaten seither ausgegeben haben.
    """
    now = time.time()
    with db() as con:
        rows = con.execute("SELECT id, kind, ts, grams, arrived FROM supply ORDER BY ts").fetchall()
    entries = [{"id": i, "kind": k, "ts": ts, "grams": g, "confirmed": arrived is not None,
                "arrives": arrived or (ts + DELIVERY_DAYS * 86400 if k == "order" else ts)}
               for i, k, ts, g, arrived in rows]
    out = {"entries": [{**e, "ts": _iso(e["ts"]), "arrives": _iso(e["arrives"])} for e in reversed(entries)],
           "deliveryDays": DELIVERY_DAYS, "reminderDays": REMINDER_DAYS, "rate": round(rate)}
    stocks = [e for e in entries if e["kind"] == "stock"]
    orders = [e for e in entries if e["kind"] == "order"]
    if not entries:
        return {**out, "known": False}

    base = stocks[-1] if stocks else {"ts": orders[0]["ts"], "grams": 0}
    counted = [o for o in orders if o["arrives"] > base["ts"]]
    with db() as con:
        portions = con.execute("SELECT COALESCE(SUM(portions), 0) FROM feed WHERE ts > ?", (base["ts"],)).fetchone()[0]
    level = base["grams"] + sum(o["grams"] for o in counted if o["arrives"] <= now) - portions * grams_per_portion
    level = max(level, 0)
    pending = [o for o in counted if o["arrives"] > now]

    # Vorrat in die Zukunft fortschreiben; Lieferungen kommen dazu, sobald sie da sind
    t, rest, gap = now, float(level), None
    per_second = rate / 86400 if rate > 0 else 0
    for o in pending:
        if per_second and rest / per_second < o["arrives"] - t and gap is None:
            gap = {"from": _iso(t + rest / per_second), "until": _iso(o["arrives"])}  # leer, bevor die Lieferung da ist
        rest = max(rest - per_second * (o["arrives"] - t), 0) + o["grams"]
        t = o["arrives"]
    runs_out = t + rest / per_second if per_second else None
    order_by = runs_out - REMINDER_DAYS * 86400 if runs_out else None
    last_chance = runs_out - DELIVERY_DAYS * 86400 if runs_out else None
    return {
        **out,
        "known": True,
        "level": round(level),
        "pending": [{"id": o["id"], "grams": o["grams"], "arrives": _iso(o["arrives"])} for o in pending],
        "runsOut": _iso(runs_out) if runs_out else None,
        "daysLeft": round((runs_out - now) / 86400, 1) if runs_out else None,
        "orderBy": _iso(order_by) if order_by else None,
        "lastChance": _iso(last_chance) if last_chance else None,
        "reminder": bool(order_by and now >= order_by),
        "urgent": bool(last_chance and now >= last_chance),
        "gap": gap,
    }


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts).isoformat(timespec="minutes")


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
