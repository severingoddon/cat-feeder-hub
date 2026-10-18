"""Lokale Steuerung der Oneisall-Futterautomaten (Tuya, Kategorie cwwsq) via tinytuya.

Beispiele:
    python feeder.py status                 # alle Datenpunkte beider Geräte
    python feeder.py plan links             # Fütterungsplan anzeigen
    python feeder.py disable links 2        # Mahlzeit Nr. 2 deaktivieren
    python feeder.py enable links 2         # Mahlzeit Nr. 2 wieder aktivieren
    python feeder.py feed rechts 1          # sofort 1 Portion füttern

Die Local Keys gehören in feeders.json, die Cloud-Zugangsdaten in tinytuya.json (beide nicht committen).

Datenpunkte (laut Tuya-Cloud-Mapping):
    DP 1 = meal_plan (raw/base64), 5 Bytes pro Mahlzeit:
           [Wochentage-Bitmaske, Stunde, Minute, Portionen, aktiv]
           Wird lokal nicht gemeldet → Lesen über die Cloud, Schreiben lokal.
    DP 3 = manual_feed (Anzahl Portionen, 1–60)
"""

import argparse
import base64
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import tinytuya

DEVICES_FILE = Path(__file__).with_name("feeders.json")

DP_MEAL_PLAN = "1"
DP_MANUAL_FEED = "3"

# Bit 0 = Montag … Bit 6 = Sonntag (Tuya-Standard; 0x7f = täglich ist bestätigt, die Reihenfolge nicht)
WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]


@dataclass
class Meal:
    days: int
    hour: int
    minute: int
    portions: int
    enabled: bool

    def to_bytes(self) -> bytes:
        return bytes([self.days, self.hour, self.minute, self.portions, int(self.enabled)])

    def describe(self) -> str:
        if self.days == 0x7F:
            days = "täglich"
        else:
            days = ",".join(d for i, d in enumerate(WEEKDAYS) if self.days & (1 << i)) or "nie"
        state = "aktiv" if self.enabled else "AUS"
        return f"{self.hour:02d}:{self.minute:02d}  {self.portions} Portion(en)  {days:<20} [{state}]  (days=0x{self.days:02x})"


def decode_plan(value: str) -> list[Meal]:
    raw = base64.b64decode(value)
    if len(raw) % 5:
        raise ValueError(f"meal_plan hat {len(raw)} Bytes, erwartet Vielfaches von 5: {raw.hex()}")
    return [Meal(raw[i], raw[i + 1], raw[i + 2], raw[i + 3], bool(raw[i + 4])) for i in range(0, len(raw), 5)]


def encode_plan(meals: list[Meal]) -> str:
    return base64.b64encode(b"".join(m.to_bytes() for m in meals)).decode()


def load_devices() -> dict:
    return json.loads(DEVICES_FILE.read_text())


def connect(key: str) -> tinytuya.Device:
    cfg = load_devices()[key]
    if not cfg["local_key"]:
        sys.exit(f"Kein local_key für '{key}' in {DEVICES_FILE.name} eingetragen.")
    dev = tinytuya.Device(cfg["id"], cfg["ip"], cfg["local_key"], version=cfg["version"])
    dev.set_socketPersistent(True)
    return dev


def get_dps(dev: tinytuya.Device) -> dict:
    result = dev.status()
    if not result or "Error" in result:
        sys.exit(f"Fehler beim Abfragen: {result}")
    return result.get("dps", {})


def get_plan(key: str) -> list[Meal]:
    # Die Geräte melden meal_plan lokal nicht im Status, die Cloud kennt aber den zuletzt gemeldeten Wert.
    # Zugangsdaten kommen aus tinytuya.json (vom `tinytuya wizard` erzeugt).
    result = tinytuya.Cloud().getstatus(load_devices()[key]["id"])
    for item in result.get("result", []):
        if item["code"] == "meal_plan":
            return decode_plan(item["value"])
    sys.exit(f"meal_plan nicht in der Cloud-Antwort: {result}")


def print_plan(meals: list[Meal]) -> None:
    for i, meal in enumerate(meals, 1):
        print(f"  {i}. {meal.describe()}")


def cmd_status(args) -> None:
    for key in [args.feeder] if args.feeder else load_devices():
        dps = get_dps(connect(key))
        print(f"== {key}")
        for dp, value in sorted(dps.items(), key=lambda kv: int(kv[0])):
            print(f"  DP {dp:>3}: {value!r}")


def cmd_plan(args) -> None:
    print_plan(get_plan(args.feeder))


def set_enabled(args, enabled: bool) -> None:
    meals = get_plan(args.feeder)
    if not 1 <= args.meal <= len(meals):
        sys.exit(f"Mahlzeit {args.meal} existiert nicht (1–{len(meals)}).")
    meals[args.meal - 1].enabled = enabled
    # Der Plan wird immer komplett geschrieben – alle anderen Mahlzeiten bleiben unverändert.
    result = connect(args.feeder).set_value(DP_MEAL_PLAN, encode_plan(meals))
    if not result or "Error" in result:
        sys.exit(f"Fehler beim Schreiben: {result}")
    print_plan(decode_plan(result["dps"][DP_MEAL_PLAN]) if DP_MEAL_PLAN in result.get("dps", {}) else meals)


def cmd_feed(args) -> None:
    print(connect(args.feeder).set_value(DP_MANUAL_FEED, args.portions))


def main() -> None:
    feeders = list(load_devices())
    parser = argparse.ArgumentParser(description="Oneisall-Futterautomaten lokal steuern")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("status", help="alle Datenpunkte anzeigen")
    p.add_argument("feeder", nargs="?", choices=feeders)
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("plan", help="Fütterungsplan anzeigen")
    p.add_argument("feeder", choices=feeders)
    p.set_defaults(func=cmd_plan)

    for name, enabled in (("enable", True), ("disable", False)):
        p = sub.add_parser(name, help=f"Mahlzeit {'aktivieren' if enabled else 'deaktivieren'}")
        p.add_argument("feeder", choices=feeders)
        p.add_argument("meal", type=int, help="Nummer aus `plan`")
        p.set_defaults(func=lambda a, e=enabled: set_enabled(a, e))

    p = sub.add_parser("feed", help="sofort füttern")
    p.add_argument("feeder", choices=feeders)
    p.add_argument("portions", type=int)
    p.set_defaults(func=cmd_feed)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
