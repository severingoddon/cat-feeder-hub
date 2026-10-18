# Schnauz-Buffet 🐾

Repo `cat-feeder-hub` · app "Schnauz-Buffet"

Web app for our two Oneisall cat feeders (PFD-002 PRO IR), running on a Raspberry Pi in the home network.
The UI is in German; page names below are given as they appear in the app.

Runs in the home network only, on a Raspberry Pi at `http://<pi-ip>:3008`.

## Features

**Main page** (`/`)
- Both feeding schedules side by side, next meal highlighted
- Skip a meal for today/tomorrow ("Für heute aussetzen"); it is re-enabled automatically afterwards
- Feed one portion right now (button under the feeder name, tap twice to confirm)
- Portions and grams per day and per bowl
- Red "order food" reminder when supplies run low
- Cat gallery, toasts, hearts

**Futterplan** (`/plan`) – feeding schedule
- Add, edit and delete feeding times, optionally for both feeders at once

**Schnauz-Analyse** (`/analyse`) – what was actually dispensed
- Grams per day (7/14/30 days), target line from the current plan
- Skipped and manually fed portions
- Daily rhythm of all dispenses, table per day

**Futterkosten** (`/kosten`) – food costs
- Cost per day, month, year and cat
- How long a pack lasts, packs per year
- Cumulative cost chart with a 30-day forecast
- Product, price per kg and pack size can be edited

**Futterbestellungen** (`/bestellungen`) – food orders
- Count current stock (including what is in the feeders)
- Record orders (3 days delivery) and confirm arrival ("Ist angekommen")
- Projection: when food runs out, when to order
- Reminder 7 days before running out

**Amounts:** each feeder has two bowls and drops 7 g into each bowl per portion, so **14 g per portion and feeder**
(constants in `web/src/app/feeder.service.ts`; the number of cats, 3, is there too).

## How it works

- The feeders are **Tuya devices** (set up in the Smart Life app, no longer in the Oneisall app).
- **Reading** the meal plan goes through the Tuya cloud (the devices don't report DP 1 locally), cached for 5 min.
- **Writing** happens locally over Wi-Fi via `tinytuya` (local key).
- **Skipping** = switch the meal off + entry in `skips.json`. A background task switches it back on
  ~2 min after the meal time.
- **Manual feeding** = set `manual_feed` (DP 3) to 1 locally (`POST /api/feeders/{key}/feed`).
- **Editing the plan** = `POST /api/feeders/{key}/meals`, `PUT`/`DELETE /api/feeders/{key}/meals/{HH:MM}`.
  New times are always daily; existing ones keep their weekdays. Limits: 1–12 portions, max. 10 times per feeder.
  Times are unique per feeder (409 on duplicates).
- **History** (`history.py`, `GET /api/analysis?days=…`): the devices report every dispense as DP 14 `feed_report`
  (portions). A background task copies the Tuya cloud log into `history.db` every 15 min, because the cloud doesn't
  keep it forever. A dispense counts as "extra" if it doesn't come within 3 min after a scheduled time (according to the
  `meal_plan` valid at that moment). Skipped meals are recorded by the server itself once they have passed.
- **Food price** (`GET`/`PUT /api/food`): product name, CHF per kg and pack size, stored in `history.db`
  (table `setting`). Default: Purina Pro Plan LiveClear Kitten Truthahn, CHF 16.25/kg, pack 1.4 kg.
- **Supply** (`GET`/`POST /api/supply`, `DELETE /api/supply/{id}`, table `supply` in `history.db`): entries are
  orders (count from "Ist angekommen", `POST /api/supply/{id}/arrived`, otherwise estimated 3 days after ordering)
  or manually counted stock (resets the level). Stock now = last count + deliveries arrived since − food dispensed since.
  The projection is cautious and uses the larger of the current plan and the 7-day average. Reminder 7 days before
  running out, "order at the latest" 3 days before (`DELIVERY_DAYS`, `REMINDER_DAYS` in `history.py`).
- **Caching:** `index.html` is served with `no-cache`, hashed JS/CSS as immutable. The app checks for a newer build
  when it becomes visible and reloads itself, so the iPhone home screen app picks up deployments.
- `meal_plan` (DP 1): 5 bytes per meal `[weekday bitmask, hour, minute, portions, enabled]`, `0x7f` = daily.

Device IDs, IPs, local keys and protocol versions of the two feeders ("links" = left, "rechts" = right) live in
`feeders.json` (not committed). Copy `feeders.example.json` and fill in the values from `python -m tinytuya wizard`.

## Files

| File | Purpose |
|---|---|
| `server.py` | FastAPI backend (API + serves the built Angular app) |
| `feeder.py` | Tuya logic + CLI (`status`, `plan`, `enable`, `disable`, `feed`) |
| `history.py` | Dispense history (cloud log → `history.db`), food settings and supply; `python history.py` syncs once |
| `history.db` | SQLite with dispenses, plan snapshots, skips, settings and supply – do not commit |
| `web/` | Angular frontend (mobile first) |
| `DESIGN.md` | Colour and UI guidelines (theme "Erde") for new features |
| `futtermessung.md` | Plan for measuring actual consumption with load cells under the feeders |
| `feeders.json` | Devices incl. IPs and local keys – **secret, do not commit** (template: `feeders.example.json`) |
| `tinytuya.json` | Tuya cloud access (created by `tinytuya wizard`) – **secret, do not commit** |
| `addons/`, `start.sh`, `captures/` | mitmproxy setup from the analysis phase (see below) |

## Development (Mac)

```bash
.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8000   # backend
cd web && npx ng serve                                       # frontend on http://<mac-ip>:4200 (proxy → :8000)
```

⚠️ Don't run it in parallel with the Pi while meals are skipped – otherwise two instances switch them back on.

CLI: `.venv/bin/python feeder.py plan links`

## Deployment (Raspberry Pi)

Runs as systemd service `naser-buffet` on port **3008** in `/home/pi/NaserBuffet` (Python venv, no Docker/Node).

**Redeploy:**

```bash
cd web && npx ng build && cd ..
PI=pi@<pi-ip>
rsync -az server.py feeder.py history.py requirements-pi.txt $PI:NaserBuffet/
rsync -az --delete web/dist/web/browser/ $PI:NaserBuffet/web/dist/web/browser/
ssh $PI 'sudo systemctl restart naser-buffet'
```

Frontend-only changes don't need the restart. Back up `history.db` on the Pi before schema changes.

**Commands on the Pi:**

```bash
systemctl status naser-buffet
journalctl -u naser-buffet -f
cat ~/NaserBuffet/skips.json          # currently skipped meals
```

## Tuya cloud access (extending IoT Core)

The meal plan and the dispense history are read through the Tuya cloud. For that, the cloud project on the
Tuya Developer Platform needs the **IoT Core** service, which runs as a free **trial** with an expiry date.

- **Project:** https://platform.tuya.com/cloud → your project
- **Check expiry and extend:** left **Cloud** → **Cloud Services** → **IoT Core** → **View Details** →
  **Extend Trial Period**. Fill in the short form (private, non-commercial project, 2 feeders); Tuya reviews it within
  a few days. Afterwards the **Expiration Date** moves to a later date.
- **Usage:** shown in the same view under "Usage/Resource Pack Quota" (Oct 2026: about 0.5 % of the monthly quota).
- The other services in the project (Authorization Token Management, Smart Home Basic Service, Data Dashboard) are permanent.

| Date | Status |
|---|---|
| 2026-10-11 | Project created, trial until 2026-11-11 21:20 |
| 2026-10-18 | Extension requested, under review |

**If access expires:** the feeders keep feeding according to their stored plan, and "1 Portion jetzt" keeps working
(local). But the main page and the plan page can't load the plan any more, skipping and editing fail, and `history.db`
gets no new dispenses (the analysis shows the last state).

## Troubleshooting

- **Device doesn't respond** → IP changed? `.venv/bin/python -m tinytuya scan`, update the IP in `feeders.json`
  (ideally reserve it in the router).
- **Device set up again in Smart Life** → new device ID + new local key: `.venv/bin/python -m tinytuya wizard`,
  copy the values into `feeders.json`.
- **Cloud errors** → Tuya IoT Core trial expired? See [Tuya cloud access](#tuya-cloud-access-extending-iot-core).

## Analysis phase (history)

The Oneisall iOS app was captured with mitmproxy (`./start.sh`). Result: `gw.oneisallapp.com` only serves extras,
device control runs through Tuya (MQTT, certificate pinning). Hence the route via Smart Life + local key.
