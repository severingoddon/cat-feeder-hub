"""Backend für die Schnauz-Buffet-Webapp.

    .venv/bin/uvicorn server:app --host 127.0.0.1 --port 8000   # Entwicklung (Angular via ng serve)
    .venv/bin/uvicorn server:app --host 0.0.0.0 --port 8000     # Betrieb: liefert auch web/dist aus

"Für heute aussetzen" schaltet eine Mahlzeit auf dem Gerät aus und merkt sich in skips.json,
wann sie wieder eingeschaltet werden muss (kurz nach der Essenszeit). Ein Hintergrund-Task
schaltet sie dann wieder ein – der Server muss dafür also laufen.

Für die Schnauz-Analyse übernimmt ein zweiter Hintergrund-Task alle 15 min das Ausgabe-Protokoll aus der
Tuya-Cloud nach history.db (siehe history.py).
"""

import asyncio
import json
import logging
import re
import time
from collections.abc import Callable
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

import history
import tinytuya
from feeder import DP_MANUAL_FEED, DP_MEAL_PLAN, Meal, connect, decode_plan, encode_plan, load_devices

SKIPS_FILE = Path(__file__).with_name("skips.json")
WEB_DIST = Path(__file__).parent / "web" / "dist" / "web" / "browser"
CLOUD_TTL = 300  # Sekunden, wie lange ein Cloud-Plan wiederverwendet wird
OWN_WRITE_TTL = 120  # nach eigenem Schreiben dem lokalen Stand trauen, bis die Cloud nachgezogen hat
REENABLE_GRACE = timedelta(minutes=2)
HISTORY_INTERVAL = 900  # Sekunden zwischen zwei Abgleichen mit dem Cloud-Log
HISTORY_MAX_AGE = 300  # älter als das → die Analyse-Seite stösst selbst einen Abgleich an
MAX_ANALYSIS_DAYS = 90
GRAMS_PER_PORTION = 14  # 2 Näpfe à 7 g – gleiche Zahl wie im Frontend (feeder.service.ts)
RATE_DAYS = 7  # Verbrauch für die Vorrats-Rechnung: Schnitt der letzten so vielen ganzen Tage
# Futter für Kosten und Bestellungen – Standard: Purina Pro Plan LiveClear Kitten Truthahn, CHF 16.25/kg
# (Preis aus dem Sparpaket 2 × 1.4 kg für CHF 45.50), eine Packung = 1.4 kg
DEFAULT_FOOD = {"name": "Purina Pro Plan LiveClear Kitten Truthahn", "pricePerKg": 16.25, "packKg": 1.4}
MAX_MEALS = 10
MAX_PORTIONS = 12
DAILY = 0x7F

log = logging.getLogger("schnauz")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

_cloud = tinytuya.Cloud()
_plans: dict[str, tuple[float, bool, list[Meal]]] = {}  # key -> (ts, eigener_write, meals)
_locks = {key: asyncio.Lock() for key in load_devices()}
_history_lock = asyncio.Lock()


def meal_id(m: Meal) -> str:
    return f"{m.hour:02d}:{m.minute:02d}"


def load_skips() -> dict:
    try:
        return json.loads(SKIPS_FILE.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def save_skips(skips: dict) -> None:
    SKIPS_FILE.write_text(json.dumps(skips, indent=2))


def _fetch_cloud_plan(key: str) -> list[Meal]:
    result = _cloud.getstatus(load_devices()[key]["id"])
    for item in result.get("result", []):
        if item["code"] == "meal_plan":
            return decode_plan(item["value"])
    raise RuntimeError(f"meal_plan nicht in Cloud-Antwort: {result}")


async def get_plan(key: str, force: bool = False) -> list[Meal]:
    cached = _plans.get(key)
    if cached:
        ts, own, meals = cached
        age = time.time() - ts
        if (own and age < OWN_WRITE_TTL) or (not force and age < CLOUD_TTL):
            return meals
    meals = await asyncio.to_thread(_fetch_cloud_plan, key)
    _plans[key] = (time.time(), False, meals)
    return meals


def find_meal(meals: list[Meal], mid: str) -> Meal:
    meal = next((m for m in meals if meal_id(m) == mid), None)
    if meal is None:
        raise HTTPException(404, f"Keine Mahlzeit um {mid}")
    return meal


async def update_plan(key: str, change: Callable[[list[Meal]], list[Meal]]) -> list[Meal]:
    """Wendet `change` auf den aktuellen Plan an und schreibt ihn komplett aufs Gerät."""
    async with _locks[key]:
        # Immer den frischesten Plan als Basis nehmen, damit Änderungen aus der App nicht überschrieben werden.
        meals = change(await get_plan(key, force=True))
        meals.sort(key=meal_id)
        result = await asyncio.to_thread(lambda: connect(key).set_value(DP_MEAL_PLAN, encode_plan(meals)))
        if not result or "Error" in result:
            raise HTTPException(502, f"Gerät hat nicht geantwortet: {result}")
        _plans[key] = (time.time(), True, meals)
        return meals


async def set_meal_enabled(key: str, mid: str, enabled: bool) -> None:
    def change(meals: list[Meal]) -> list[Meal]:
        find_meal(meals, mid).enabled = enabled
        return meals

    await update_plan(key, change)
    log.info("%s %s → %s", key, mid, "an" if enabled else "aus")


def drop_skip(key: str, mid: str) -> bool:
    skips = load_skips()
    found = skips.pop(f"{key}|{mid}", None) is not None
    if found:
        save_skips(skips)
    return found


def next_occurrence(m: Meal, now: datetime) -> datetime:
    at = now.replace(hour=m.hour, minute=m.minute, second=0, microsecond=0)
    return at if at > now else at + timedelta(days=1)


async def reenable_loop() -> None:
    while True:
        skips = load_skips()
        now = datetime.now()
        for skey, info in list(skips.items()):
            if datetime.fromisoformat(info["until"]) > now:
                continue
            key, mid = skey.split("|")
            # Die Mahlzeit ist ausgefallen – das Gerät meldet das nicht, also selbst für die Analyse festhalten.
            history.record_skip(key, datetime.fromisoformat(info["for"]), info.get("portions", 1))
            try:
                await set_meal_enabled(key, mid, True)
                skips.pop(skey)
                save_skips(skips)
            except Exception as e:  # Gerät offline o. Ä. → beim nächsten Durchlauf nochmals
                log.warning("Wiedereinschalten %s fehlgeschlagen: %s", skey, e)
        await asyncio.sleep(30)


async def sync_history() -> None:
    async with _history_lock:
        new = await asyncio.to_thread(history.sync, _cloud)
    if new:
        log.info("Verlauf: %d neue Ausgaben aus der Cloud", new)


async def history_loop() -> None:
    while True:
        try:
            await sync_history()
        except Exception as e:  # Cloud nicht erreichbar → beim nächsten Durchlauf nochmals
            log.warning("Verlauf abgleichen fehlgeschlagen: %s", e)
        await asyncio.sleep(HISTORY_INTERVAL)


@asynccontextmanager
async def lifespan(_: FastAPI):
    tasks = [asyncio.create_task(reenable_loop()), asyncio.create_task(history_loop())]
    yield
    for task in tasks:
        task.cancel()


app = FastAPI(lifespan=lifespan)


@app.get("/api/feeders")
async def feeders(refresh: bool = False):
    skips = load_skips()
    now = datetime.now()
    out = []
    for key, cfg in load_devices().items():
        try:
            meals = await get_plan(key, force=refresh)
            error = None
        except Exception as e:
            meals, error = [], str(e)
        items = []
        for m in meals:
            mid = meal_id(m)
            skip = skips.get(f"{key}|{mid}")
            items.append({
                "id": mid,
                "hour": m.hour,
                "minute": m.minute,
                "portions": m.portions,
                "enabled": m.enabled,
                "days": m.days,
                "skippedFor": skip["for"] if skip else None,
                "next": next_occurrence(m, now).isoformat(),
            })
        out.append({"key": key, "name": cfg["name"], "meals": items, "error": error})
    return {"now": now.isoformat(), "feeders": out}


@app.post("/api/feeders/{key}/meals/{mid}/skip")
async def skip(key: str, mid: str):
    if key not in _locks:
        raise HTTPException(404, "Unbekanntes Gerät")
    meals = await get_plan(key)
    meal = next((m for m in meals if meal_id(m) == mid), None)
    if meal is None:
        raise HTTPException(404, f"Keine Mahlzeit um {mid}")
    at = next_occurrence(meal, datetime.now())
    await set_meal_enabled(key, mid, False)
    skips = load_skips()
    skips[f"{key}|{mid}"] = {"for": at.isoformat(), "until": (at + REENABLE_GRACE).isoformat(), "portions": meal.portions}
    save_skips(skips)
    return {"ok": True, "skippedFor": at.isoformat()}


@app.delete("/api/feeders/{key}/meals/{mid}/skip")
async def unskip(key: str, mid: str):
    if key not in _locks:
        raise HTTPException(404, "Unbekanntes Gerät")
    await set_meal_enabled(key, mid, True)
    skips = load_skips()
    skips.pop(f"{key}|{mid}", None)
    save_skips(skips)
    return {"ok": True}


@app.post("/api/feeders/{key}/feed")
async def feed(key: str):
    if key not in _locks:
        raise HTTPException(404, "Unbekanntes Gerät")
    async with _locks[key]:
        result = await asyncio.to_thread(lambda: connect(key).set_value(DP_MANUAL_FEED, 1))
    if not result or "Error" in result:
        raise HTTPException(502, f"Gerät hat nicht geantwortet: {result}")
    log.info("%s manuell gefüttert (1 Portion)", key)
    return {"ok": True}


async def fresh_history() -> str | None:
    """Gleicht den Verlauf ab, wenn er älter als HISTORY_MAX_AGE ist. Gibt einen Fehlertext zurück, falls das scheitert."""
    if time.time() - history.last_sync() > HISTORY_MAX_AGE:
        try:
            await sync_history()
        except Exception as e:  # dann eben mit dem Stand aus history.db
            return str(e)
    return None


async def current_plans() -> tuple[dict[str, list[Meal]], list[dict], str | None]:
    error = None
    skips = load_skips()
    current, feeders = {}, []
    for key, cfg in load_devices().items():
        try:
            meals = await get_plan(key)
        except Exception as e:
            meals, error = [], str(e)
        current[key] = meals
        # Soll = was der Plan an einem normalen Tag ausgibt: aktive plus nur heute ausgesetzte Mahlzeiten
        plan = sum(m.portions for m in meals if m.enabled or f"{key}|{meal_id(m)}" in skips)
        feeders.append({"key": key, "name": cfg["name"], "planPortions": plan})
    return current, feeders, error


@app.get("/api/analysis")
async def analysis(days: int = 30):
    """Ausgegebene Portionen pro Tag und Automat, dazu Einzelereignisse und der Soll-Wert laut aktuellem Plan."""
    days = max(1, min(days, MAX_ANALYSIS_DAYS))
    sync_error = await fresh_history()
    current, feeders, error = await current_plans()
    result = await asyncio.to_thread(history.analysis, days, current)
    return {"now": datetime.now().isoformat(), "feeders": feeders, "error": sync_error or error, **result}


class FoodIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    pricePerKg: float = Field(gt=0, le=500)
    packKg: float = Field(gt=0, le=50)


def load_food() -> dict:
    stored = history.load_settings()
    food = dict(DEFAULT_FOOD)
    if "food.name" in stored:
        food["name"] = stored["food.name"]
    for key in ("pricePerKg", "packKg"):
        if f"food.{key}" in stored:
            food[key] = float(stored[f"food.{key}"])
    return food


@app.get("/api/food")
async def get_food():
    return load_food()


@app.put("/api/food")
async def put_food(body: FoodIn):
    history.save_settings({"food.name": body.name.strip(), "food.pricePerKg": str(body.pricePerKg), "food.packKg": str(body.packKg)})
    log.info("Futter: %s, CHF %.2f/kg, Packung %.2f kg", body.name, body.pricePerKg, body.packKg)
    return load_food()


# ---------- Vorrat & Bestellungen ----------


class SupplyIn(BaseModel):
    kind: str = Field(pattern="^(order|stock)$")
    date: str | None = None  # YYYY-MM-DD, nur bei Bestellungen; Vorrat gilt immer ab jetzt
    kg: float = Field(gt=0, le=100)


async def expected_rate() -> tuple[float, str]:
    """Erwarteter Verbrauch in g/Tag – vorsichtig: das Grössere aus Schnitt der letzten ganzen Tage und aktuellem Plan."""
    current, feeders, _ = await current_plans()
    plan = sum(f["planPortions"] for f in feeders) * GRAMS_PER_PORTION
    data = await asyncio.to_thread(history.analysis, RATE_DAYS + 1, current)
    today = datetime.now().date().isoformat()
    full = [d for d in data["days"] if d["date"] != today and data["since"] and d["date"] > data["since"]]
    average = sum(c["portions"] for d in full for c in d["feeders"].values()) * GRAMS_PER_PORTION / len(full) if full else 0
    return (plan, "plan") if plan >= average else (average, "average")


@app.get("/api/supply")
async def get_supply():
    error = await fresh_history()
    rate, basis = await expected_rate()
    status = await asyncio.to_thread(history.supply, rate, GRAMS_PER_PORTION)
    return {**status, "rateBasis": basis, "error": error}


@app.post("/api/supply")
async def add_supply(body: SupplyIn):
    if body.kind == "order":
        try:
            day = datetime.fromisoformat(body.date) if body.date else datetime.now()
        except ValueError:
            raise HTTPException(422, "Datum ungültig")
        # Bestellungen von heute zählen ab jetzt, frühere ab Mittag des Bestelltags
        ts = time.time() if day.date() == datetime.now().date() else day.replace(hour=12, minute=0).timestamp()
        if ts > time.time() + 60:
            raise HTTPException(422, "Bestellung liegt in der Zukunft")
    else:
        ts = time.time()
    entry_id = history.add_supply(body.kind, ts, round(body.kg * 1000))
    log.info("Vorrat: %s %.2f kg", "Bestellung" if body.kind == "order" else "gezählt", body.kg)
    return {"ok": True, "id": entry_id}


@app.post("/api/supply/{entry_id}/arrived")
async def supply_arrived(entry_id: int):
    """Bestellung ist da – zählt ab jetzt zum Vorrat statt erst nach der geschätzten Lieferfrist."""
    if not history.confirm_arrival(entry_id, time.time()):
        raise HTTPException(404, "Bestellung nicht gefunden")
    log.info("Vorrat: Lieferung %d angekommen", entry_id)
    return {"ok": True}


@app.delete("/api/supply/{entry_id}")
async def delete_supply(entry_id: int):
    if not history.delete_supply(entry_id):
        raise HTTPException(404, "Eintrag nicht gefunden")
    return {"ok": True}


# ---------- Futterplan bearbeiten ----------
# Neue Mahlzeiten gelten immer täglich; bei bestehenden bleiben Wochentage und aktiv-Status unverändert.


class MealIn(BaseModel):
    hour: int = Field(ge=0, le=23)
    minute: int = Field(ge=0, le=59)
    portions: int = Field(ge=1, le=MAX_PORTIONS)


def check_key(key: str) -> None:
    if key not in _locks:
        raise HTTPException(404, "Unbekanntes Gerät")


def check_free(meals: list[Meal], mid: str, ignore: str | None = None) -> None:
    if mid != ignore and any(meal_id(m) == mid for m in meals):
        raise HTTPException(409, f"Um {mid} gibt es schon eine Mahlzeit")


@app.post("/api/feeders/{key}/meals")
async def add_meal(key: str, body: MealIn):
    check_key(key)
    new = Meal(DAILY, body.hour, body.minute, body.portions, True)

    def change(meals: list[Meal]) -> list[Meal]:
        check_free(meals, meal_id(new))
        if len(meals) >= MAX_MEALS:
            raise HTTPException(409, f"Mehr als {MAX_MEALS} Mahlzeiten gehen nicht")
        return [*meals, new]

    await update_plan(key, change)
    log.info("%s neue Mahlzeit %s (%d Portionen)", key, meal_id(new), new.portions)
    return {"ok": True, "id": meal_id(new)}


@app.put("/api/feeders/{key}/meals/{mid}")
async def edit_meal(key: str, mid: str, body: MealIn):
    check_key(key)
    new_mid = f"{body.hour:02d}:{body.minute:02d}"
    # Eine ausgesetzte Mahlzeit, die auf eine andere Zeit wandert, wird wieder eingeschaltet –
    # sonst bliebe sie ohne skips.json-Eintrag für immer aus.
    unskip = new_mid != mid and f"{key}|{mid}" in load_skips()

    def change(meals: list[Meal]) -> list[Meal]:
        check_free(meals, new_mid, ignore=mid)
        meal = find_meal(meals, mid)
        meal.hour, meal.minute, meal.portions = body.hour, body.minute, body.portions
        if unskip:
            meal.enabled = True
        return meals

    await update_plan(key, change)
    if new_mid != mid:
        drop_skip(key, mid)
    log.info("%s Mahlzeit %s → %s (%d Portionen)", key, mid, new_mid, body.portions)
    return {"ok": True, "id": new_mid}


@app.delete("/api/feeders/{key}/meals/{mid}")
async def delete_meal(key: str, mid: str):
    check_key(key)

    def change(meals: list[Meal]) -> list[Meal]:
        meal = find_meal(meals, mid)
        return [m for m in meals if m is not meal]

    await update_plan(key, change)
    drop_skip(key, mid)
    log.info("%s Mahlzeit %s gelöscht", key, mid)
    return {"ok": True}


HASHED_ASSET = re.compile(r"-[A-Z0-9]{8}\.(js|css)$")  # von ng build, Name ändert sich bei jedem Build


class SpaFiles(StaticFiles):
    """Liefert für unbekannte Pfade (z. B. /plan nach einem Reload) die index.html der Angular-App.

    index.html darf nie ungeprüft aus dem Cache kommen, sonst bleibt die Homescreen-App auf dem iPhone
    nach einem Deployment auf der alten Version. JS/CSS haben einen Hash im Namen und dürfen ewig gecacht werden.
    """

    async def get_response(self, path, scope):
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as e:
            if e.status_code != 404 or path.startswith("api/"):
                raise
            response = await super().get_response("index.html", scope)
        if response.media_type and response.media_type.startswith("text/html"):
            response.headers["Cache-Control"] = "no-cache"
        elif HASHED_ASSET.search(path):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


# Gebaute Angular-App (ng build) mit ausliefern – muss nach den API-Routen stehen.
if WEB_DIST.is_dir():
    app.mount("/", SpaFiles(directory=WEB_DIST, html=True), name="web")
