# Schnauz-Buffet 🐾

Repo `cat-feeder-hub` · App „Schnauz-Buffet“

Webapp für die beiden Oneisall-Futterautomaten (PFD-002 PRO IR). Zeigt beide Futterpläne nebeneinander
und erlaubt, jede Mahlzeit einmalig auszusetzen („Für heute aussetzen“) sowie pro Automat sofort
eine Portion manuell zu füttern (Knopf unter dem Namen, zweimal tippen zum Bestätigen).
Über das Burger-Menü oben links erreicht man den **Futterplan** (`/plan`): Futterzeiten anlegen (optional gleich
für beide Automaten), Uhrzeit und Portionen ändern, Zeiten löschen. Die **Schnauz-Analyse** (`/analyse`) zeigt, wie viel
Futter tatsächlich ausgegeben wurde (Gramm pro Tag, Tagesrhythmus, ausgesetzte und von Hand gefütterte Portionen).
Die **Futterkosten** (`/kosten`) rechnen das mit dem Kilopreis in CHF um: pro Tag, Monat, Jahr und Katze, Reichweite
einer Packung und eine Prognose für die nächsten 30 Tage. Unter **Futterbestellungen** (`/bestellungen`) erfasst man
Bestellungen und den aktuellen Vorrat; die App rechnet aus, wann das Futter ausgeht, und zeigt 7 Tage vorher auf der
Hauptseite einen roten Hinweis „Futter bestellen“.

**Mengen:** Jeder Automat hat zwei Näpfe, pro Portion fallen in jeden Napf 7 g, also **14 g pro Portion und Automat**
(Konstanten in `web/src/app/feeder.service.ts`).

**Live (nur LAN):** http://192.168.1.51:3008

## Wie es funktioniert

- Die Automaten sind **Tuya-Geräte** (in der Smart-Life-App eingerichtet, nicht mehr in der Oneisall-App).
- **Lesen** des Futterplans über die Tuya-Cloud (lokal melden die Geräte DP 1 nicht), 5 min gecacht.
- **Schreiben** lokal im WLAN via `tinytuya` (Local Key).
- **Aussetzen** = Mahlzeit ausschalten + Eintrag in `skips.json`. Ein Hintergrund-Task schaltet sie
  ~2 min nach der Essenszeit wieder ein.
- **Manuell füttern** = `manual_feed` (DP 3) lokal auf 1 setzen (`POST /api/feeders/{key}/feed`).
- **Futterplan bearbeiten** = `POST /api/feeders/{key}/meals`, `PUT`/`DELETE /api/feeders/{key}/meals/{HH:MM}`.
  Neue Zeiten sind immer täglich, bei bestehenden bleiben die Wochentage. Grenzen: 1–12 Portionen, max. 10 Zeiten pro Automat.
  Uhrzeit pro Automat eindeutig (409 bei Duplikat).
- **Verlauf** (`history.py`, `GET /api/analysis?days=…`): Die Geräte melden jede Ausgabe als DP 14 `feed_report`
  (Portionen). Ein Hintergrund-Task übernimmt das Tuya-Cloud-Log alle 15 min nach `history.db`, weil die Cloud
  nicht ewig aufbewahrt. Eine Ausgabe gilt als „extra“, wenn sie nicht innerhalb von 3 min nach einer Planzeit
  (laut damals gültigem `meal_plan`) kommt. Ausgesetzte Mahlzeiten trägt der Server selbst ein, sobald sie abgelaufen sind.
- **Futterpreis** (`GET`/`PUT /api/food`): Produktname, CHF pro kg und Packungsgrösse, gespeichert in `history.db`
  (Tabelle `setting`). Standard: Purina Pro Plan LiveClear Kitten Truthahn, CHF 16.25/kg, Packung 1.4 kg.
- **Vorrat** (`GET`/`POST /api/supply`, `DELETE /api/supply/{id}`, Tabelle `supply` in `history.db`): Einträge sind
  Bestellungen (kommen nach 3 Tagen an) oder von Hand gezählter Vorrat (setzt den Stand neu). Vorrat jetzt = letzte
  Zählung + seither angekommene Lieferungen − seither ausgegebenes Futter. Hochgerechnet wird vorsichtig mit dem
  Grösseren aus aktuellem Plan und Schnitt der letzten 7 Tage. Erinnerung 7 Tage vor dem Auslaufen, „spätestens
  bestellen“ 3 Tage vorher (`DELIVERY_DAYS`, `REMINDER_DAYS` in `history.py`).
- `meal_plan` (DP 1): 5 Bytes pro Mahlzeit `[Wochentage-Bitmaske, Stunde, Minute, Portionen, aktiv]`, `0x7f` = täglich.

| Gerät | IP | Device ID | Protokoll |
|---|---|---|---|
| Automat links | 192.168.1.104 | bf96336877275e5df5unjx | 3.5 |
| Automat rechts | 192.168.1.81 | bf0b9b093ec4987bd1ewhp | 3.4 |

## Dateien

| Datei | Zweck |
|---|---|
| `server.py` | FastAPI-Backend (API + liefert die gebaute Angular-App aus) |
| `feeder.py` | Tuya-Logik + CLI (`status`, `plan`, `enable`, `disable`, `feed`) |
| `history.py` | Ausgabe-Verlauf (Cloud-Log → `history.db`) für die Schnauz-Analyse; `python history.py` gleicht einmal ab |
| `history.db` | SQLite mit Ausgaben, Plan-Ständen und Aussetzungen – nicht committen |
| `web/` | Angular-Frontend (mobile first) |
| `DESIGN.md` | Farb- und UI-Vorgaben (Theme „Erde“) für neue Features |
| `feeders.json` | Geräte inkl. Local Keys – **geheim, nicht committen** |
| `tinytuya.json` | Tuya-Cloud-Zugang (Projekt „NaserProject“, iot.tuya.com) – **geheim** |
| `addons/`, `start.sh`, `captures/` | mitmproxy-Setup aus der Analysephase (siehe unten) |

## Entwicklung (Mac)

```bash
.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8000   # Backend
cd web && npx ng serve                                       # Frontend auf http://<mac-ip>:4200 (Proxy → :8000)
```

⚠️ Nicht parallel zum Pi laufen lassen, wenn Mahlzeiten ausgesetzt werden – sonst schalten zwei Instanzen wieder ein.

CLI: `.venv/bin/python feeder.py plan links`

## Deployment (Raspberry Pi)

Läuft als systemd-Dienst `naser-buffet` auf Port **3008** unter `/home/pi/NaserBuffet` (Python-venv, kein Docker/Node).

**Redeploy:**

```bash
cd web && npx ng build && cd ..
rsync -az server.py feeder.py history.py requirements-pi.txt pi@192.168.1.51:NaserBuffet/
rsync -az --delete web/dist/web/browser/ pi@192.168.1.51:NaserBuffet/web/dist/web/browser/
ssh pi@192.168.1.51 'sudo systemctl restart naser-buffet'
```

**Befehle auf dem Pi:**

```bash
systemctl status naser-buffet
journalctl -u naser-buffet -f
cat ~/NaserBuffet/skips.json          # aktuell ausgesetzte Mahlzeiten
```

## Tuya-Cloud-Zugang (IoT Core verlängern)

Futterplan und Ausgabe-Verlauf werden über die Tuya-Cloud gelesen. Dafür braucht das Projekt „NaserProject“ auf der
Tuya Developer Platform den Dienst **IoT Core**, und der läuft als kostenlose **Testversion** mit Ablaufdatum.

- **Projekt:** https://platform.tuya.com/cloud/basic?id=p1791746381029uh3ce9&toptab=project
- **Ablaufdatum prüfen und verlängern:** links **Cloud** → **Cloud Services** → bei **IoT Core** auf **View Details** →
  **Extend Trial Period**. Kurzes Formular ausfüllen (privates, nicht kommerzielles Projekt, 2 Automaten), Tuya prüft
  das in ein paar Tagen. Danach springt das **Expiration Date** auf ein späteres Datum.
- **Verbrauch:** steht in derselben Ansicht unter „Usage/Resource Pack Quota“ (Okt. 2026: ca. 0.5 % des Monatskontingents).
- Die anderen Dienste im Projekt (Authorization Token Management, Smart Home Basic Service, Data Dashboard) sind permanent.

| Datum | Stand |
|---|---|
| 11.10.2026 | Projekt erstellt, Testversion bis 11.11.2026 21:20 |
| 18.10.2026 | Verlängerung beantragt, wird geprüft |

**Wenn der Zugang abläuft:** Die Automaten füttern weiter nach ihrem gespeicherten Plan, und „1 Portion jetzt“ geht
weiter (läuft lokal). Hauptseite und Futterplan können den Plan aber nicht mehr laden, Aussetzen und Plan ändern
schlagen fehl, und `history.db` bekommt keine neuen Ausgaben mehr (die Analyse zeigt den letzten Stand).

## Wenn etwas nicht geht

- **Gerät antwortet nicht** → IP geändert? `.venv/bin/python -m tinytuya scan`, IP in `feeders.json` anpassen
  (am besten im Router fest reservieren).
- **Gerät neu in Smart Life eingerichtet** → neue Device-ID + neuer Local Key: `.venv/bin/python -m tinytuya wizard`,
  Werte in `feeders.json` übernehmen.
- **Cloud-Fehler** → Tuya IoT-Core-Testphase abgelaufen? Siehe [Tuya-Cloud-Zugang](#tuya-cloud-zugang-iot-core-verlängern).

## Analysephase (Historie)

Die Oneisall-iOS-App wurde mit mitmproxy (`./start.sh`) mitgeschnitten. Ergebnis: `gw.oneisallapp.com` liefert nur
Beiwerk, die Gerätesteuerung läuft über Tuya (MQTT, Certificate Pinning). Daher der Weg über Smart Life + Local Key.
