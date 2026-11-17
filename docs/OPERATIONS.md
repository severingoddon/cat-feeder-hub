# Operations

## Configuration files

None of these are committed:

| File | Contents | How to create |
|---|---|---|
| `feeders.json` | Device ID, IP, local key and protocol version per feeder (`links` = left, `rechts` = right) | Copy `feeders.example.json` and fill in the values from `python -m tinytuya wizard` |
| `tinytuya.json` | Tuya cloud access (API key and secret) | Created by `python -m tinytuya wizard` |
| `history.db` | SQLite with dispenses, plan snapshots, skips, food settings and supply | Created automatically |
| `skips.json` | Meals that are currently skipped | Created automatically |

## Deployment (Raspberry Pi)

The app runs as the systemd service `naser-buffet` on port **3008** in `/home/pi/NaserBuffet`. It uses a Python venv and needs no Docker or Node on the Pi. The FastAPI server also serves the built Angular app.

```bash
cd web && npx ng build && cd ..
PI=pi@<pi-ip>
rsync -az server.py feeder.py history.py requirements-pi.txt $PI:NaserBuffet/
rsync -az --delete web/dist/web/browser/ $PI:NaserBuffet/web/dist/web/browser/
ssh $PI 'sudo systemctl restart naser-buffet'
```

- Changes to the frontend only don't need a restart.
- Back up `history.db` on the Pi before schema changes.

Useful commands on the Pi:

```bash
systemctl status naser-buffet
journalctl -u naser-buffet -f
cat ~/NaserBuffet/skips.json          # meals that are currently skipped
```

## How it works

- **Reading** the meal plan goes through the Tuya cloud, because the devices don't report data point 1 locally. The result is cached for 5 minutes.
- **Writing** happens locally over Wi-Fi with `tinytuya`, using the local key.
- **Skipping** switches the meal off and adds an entry to `skips.json`. A background task switches it back on about 2 minutes after the meal time.
- **Manual feeding** sets `manual_feed` (data point 3) locally.
- **Editing the plan:** new times are always daily, and existing ones keep their weekdays. A feeder allows 1–12 portions per meal and at most 10 times. Times are unique per feeder (`409` on duplicates).
- **History:** the devices report every dispense as data point 14 (`feed_report`). A background task copies the cloud log into `history.db` every 15 minutes. A dispense counts as *extra* if it doesn't come within 3 minutes after a scheduled time of the plan valid at that moment. A ±1 h device clock offset is allowed, because the feeders don't always follow daylight-saving changes. The server records skipped meals itself once they have passed.
- **Amounts:** each feeder has two bowls and drops 7 g into each bowl per portion, so one portion is 14 g per feeder. These constants and the number of cats are in `web/src/app/feeder.service.ts`.
- **Supply:** stock now = last count + deliveries since − food dispensed since. Orders arrive when confirmed, or are estimated 3 days after ordering. A reminder appears 7 days before food runs out, and "order at the latest" 3 days before (`DELIVERY_DAYS`, `REMINDER_DAYS` in `history.py`).

## API overview

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/feeders` | Both feeders with their meal plan and skip state |
| POST | `/api/feeders/{key}/feed` | Dispense one portion now |
| POST | `/api/feeders/{key}/meals` | Add a feeding time |
| PUT / DELETE | `/api/feeders/{key}/meals/{HH:MM}` | Edit or delete a feeding time |
| POST / DELETE | `/api/feeders/{key}/meals/{HH:MM}/skip` | Skip a meal once, or undo the skip |
| GET | `/api/analysis?days=…` | Dispense history and analysis |
| GET / PUT | `/api/food` | Food product, price per kg and pack size |
| GET / POST | `/api/supply` | Supply entries and forecast; record an order or a stock count |
| POST | `/api/supply/{id}/arrived` | Confirm that an order arrived |
| DELETE | `/api/supply/{id}` | Delete a supply entry |

Write requests from other websites are rejected (CSRF protection). The API has no login and is meant for the home network only.

## Tuya cloud access (IoT Core)

The meal plan and the dispense history are read through the Tuya cloud. For that, the cloud project on the Tuya Developer Platform needs the **IoT Core** service, which runs as a free **trial** with an expiry date.

- **Check expiry and extend:** in [platform.tuya.com/cloud](https://platform.tuya.com/cloud), open your project → **Cloud** → **Cloud Services** → **IoT Core** → **View Details** → **Extend Trial Period**. Fill in the short form (private, non-commercial project, 2 feeders). Tuya reviews it within a few days, and the **Expiration Date** then moves to a later date.
- **Usage:** shown in the same view under "Usage/Resource Pack Quota". In October 2026 it was about 0.5 % of the monthly quota.
- The other services in the project (Authorization Token Management, Smart Home Basic Service, Data Dashboard) don't expire.

| Date | Status |
|---|---|
| 2026-10-11 | Project created, trial until 2026-11-11 21:20 |
| 2026-10-18 | Extension requested, under review |

**If access expires:**
- The feeders keep feeding according to their stored plan, and "1 Portion jetzt" keeps working, because it is local.
- The main page and the plan page can't load the plan any more, and skipping and editing fail.
- `history.db` gets no new dispenses, so the analysis shows the last state.

## Troubleshooting

- **A device doesn't respond:** its IP may have changed. Run `.venv/bin/python -m tinytuya scan` and update the IP in `feeders.json`. Ideally, reserve the IP in the router.
- **A device was set up again in Smart Life:** it gets a new device ID and a new local key. Run `.venv/bin/python -m tinytuya wizard` and copy the values into `feeders.json`.
- **Cloud errors:** the Tuya IoT Core trial may have expired. See above.

## Analysis phase

The Oneisall iOS app was captured with mitmproxy (`./start.sh`, addon in `addons/capture.py`). The vendor backend `gw.oneisallapp.com` only serves extras. Device control runs through Tuya (MQTT with certificate pinning), which is why the feeders are controlled through Smart Life and the local key instead.
