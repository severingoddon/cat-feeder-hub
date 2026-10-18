# Futtermessung mit Waagen

Ziel: messen, **wie viel die Katzen fressen und wann**, und nebenbei den Füllstand beider Automaten kennen.
Das kommt auf die App-Seite **„Schnauz-Analyse“** (`/analyse`), die heute schon zeigt, was ausgegeben wurde.

## Prinzip

Jeder Automat steht auf einem eigenen Brett, unter jedem Brett sitzt eine Waage. Der Napf hängt am Automaten und
steht damit **auch auf dem Brett**. Das heisst:

- **Ausgeben** ändert das Gewicht nicht: Das Futter wandert nur vom Behälter in den Napf.
- **Fressen** macht das Brett leichter. Jede Abnahme ist direkt gefressenes Futter.
- **Nachfüllen** macht das Brett schwerer und setzt den Bezugspunkt „voll“ neu.

Der Füllstand ergibt sich aus derselben Messung (aktuelles Gewicht minus Leergewicht), also braucht es keinen
separaten Sensor. Der frühere Plan mit einem Laser-Distanzsensor (DFRobot SEN0590) unter dem Deckel ist damit verworfen.

## Störungen: Katzen auf dem Brett

Die Katzen stehen, sitzen oder liegen auf dem Automaten (Apollon wiegt 5 kg). Deshalb zählen nur **stabile
Messungen**:

- **Stabil** heisst: Das Gewicht bleibt **1 Minute lang** innerhalb einer kleinen Toleranz (Startwert ±5 g,
  wird nach den ersten Messungen angepasst). Alles andere wird ignoriert.
- **Plausibel** heisst: Ein stabiler Wert liegt zwischen Leergewicht und Leergewicht plus maximaler Futtermenge
  (Behälter 5 l ≈ 2.1 kg, Grenze mit Reserve ca. 2.5 kg).
  Schläft eine Katze eine Minute lang auf dem Automaten, ist der Wert zwar stabil, aber um Kilos zu hoch, und wird verworfen.
- Ausgewertet wird immer nur die **Differenz zwischen zwei gültigen Ruhewerten**.

## Auswertung im Backend

| Ereignis | Erkennung | Folge |
|---|---|---|
| Gefressen | neuer Ruhewert ist leichter als der vorherige | Menge = Differenz, Zeitpunkt = Ende der Unruhe davor |
| Nachgefüllt | neuer Ruhewert ist **≥ 300 g schwerer** (eine Packung = 1 kg, nachgefüllt wird also immer viel) | neuer Bezugspunkt „voll“ (Auto-Tara), kein Verzehr |
| Unklar | neuer Ruhewert ist 5–300 g schwerer (z. B. Gegenstand abgelegt) | neuer Bezugspunkt, kein Verzehr, als Auffälligkeit loggen |
| Katze drauf / Unruhe | Wert schwankt oder ist unplausibel hoch | ignorieren |

Nachfüllen lässt sich zusätzlich über DP 12 `cover_state` (Deckel offen) bestätigen. Diesen Datenpunkt meldet der Automat lokal.
In der App gibt es zusätzlich einen Knopf **„Ist jetzt voll“** für manuelles Taren.

**Einmalige Kalibrierung pro Automat:**

1. Waage mit einem bekannten Gewicht eichen (Faktor Rohwert → Gramm).
2. **Leergewicht** messen: Automat samt leerem Napf, ohne Futter.
3. **Gramm pro Portion** ist bekannt: 7 g pro Napf, also 14 g pro Automat (zwei Näpfe). Zur Kontrolle einmal zehn Portionen
   auswerfen und wägen. Damit wird aus dem Futterplan eine Futtermenge in Gramm, und es lässt sich berechnen, **was im Napf liegen bleibt** (serviert minus gefressen).

## Architektur

Kein neues Backend nötig: `server.py` auf dem Pi wird erweitert.

```
Waage (pro Brett) → Mikrocontroller → POST /api/weight → server.py (Pi) → SQLite → Schnauz-Analyse
```

- **Rohdaten:** etwa alle 2–5 Sekunden ein Messwert pro Waage. So lässt sich die Ruhe-Erkennung über 1 Minute sauber
  rechnen. Die Rohdaten werden nach einigen Tagen gelöscht.
- **Dauerhaft gespeichert** werden nur Ruhewerte und erkannte Ereignisse. Das sind wenige MB pro Jahr.
- **Speicher:** `weights.db` (SQLite) neben `skips.json`, nicht committen.

| Tabelle | Inhalt |
|---|---|
| `raw` | `feeder`, `ts`, `grams` (rollierend, wenige Tage) |
| `rest` | gültige Ruhewerte: `feeder`, `ts`, `grams` |
| `event` | `feeder`, `ts`, `type` (eaten / refill / tare), `grams` |
| `calibration` | pro Automat: Faktor, Leergewicht, Gramm pro Portion, aktueller Wert „voll“ |

**Endpoints:**

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/weight` | Messwert vom Mikrocontroller (`feeder`, `grams` oder Rohwert) |
| POST | `/api/feeders/{key}/tare` | „Ist jetzt voll“ von Hand |
| GET | `/api/feeders/{key}/level` | aktueller Füllstand in g und % |
| GET | `/api/consumption?from=…&to=…` | Fress-Ereignisse und Tagessummen für die Analyse |

## App: Seite „Schnauz-Analyse“

Schon da (ohne Waagen): ausgegebene Gramm pro Tag aus `feed_report`, Soll laut Plan, Tagesrhythmus, ausgesetzte und
von Hand gefütterte Portionen. Mit den Waagen kommt dazu:

Ideen, die Reihenfolge ist noch offen:

- **Füllstand** pro Automat als Balken, dazu „reicht noch ca. X Tage“ (aus dem Verbrauch der letzten 7 Tage).
- **Heute gefressen** in g pro Automat, im Vergleich zum Schnitt.
- **Tagesverlauf:** Wann wurde gefressen, mit den Fütterungszeiten aus dem Plan als Markierungen. Wie schnell nach dem
  Servieren wird gegessen?
- **Reste:** Was vom Servierten bleibt liegen?
- **Verlauf über Wochen:** gefressene Menge pro Tag, um Auffälligkeiten früh zu sehen (frisst eine Katze plötzlich weniger?).

Welche Katze an welchem Automaten frisst, kann die Waage nicht unterscheiden.

## Hardware

Anforderungen: auf **1 g** genau (0.5 g wäre schön), Normalbetrieb ca. 5 kg pro Brett, darf nicht kaputtgehen,
wenn Apollon (5 kg) draufsteht oder -springt.

| Posten | Gewicht |
|---|---|
| Automat leer | ca. 1.9 kg |
| Futter voll (5 l) | ca. 2.1 kg (eine Packung = 1 kg) |
| Brett | ca. 1 kg |
| **Normalbetrieb** | **ca. 5 kg** |
| mit Apollon | ca. 10 kg, beim Sprung kurz mehr |

**Gewählt:**

- **Pro Brett eine Single-Point-Wägezelle 20 kg** (Aluminium-Biegebalken wie in Küchen- und Ladenwaagen).
  Damit braucht es nur 2 Zellen insgesamt, und es ist egal, wo die Last auf der Platte steht. Platte laut Datenblatt mindestens 300 × 300 mm.
  Sichere Überlast typischerweise 150 % = 30 kg.
- **Mechanischer Überlastanschlag:** Schraube unter der oberen Platte mit ca. 1 mm Luft zur Grundplatte, damit Apollons
  Sprünge den Balken nicht überdehnen.
- **Pro Brett ein HX711** (24-Bit-Wandler, 10 Messungen/s). Board mit getrenntem VDD-Pin (z. B. SparkFun): VCC an 5 V, VDD an 3.3 V,
  damit die Signale für den Wemos 3.3 V haben.
- **Ein Wemos D1 mini für beide Waagen**, weil die Automaten nebeneinander stehen. Jeder HX711 braucht 2 Pins.
  Der NAU7802 als Alternative fällt weg, weil zwei davon dieselbe I²C-Adresse hätten.

| HX711 | DOUT | SCK |
|---|---|---|
| links | D5 | D6 |
| rechts | D7 | D1 |

  D3, D4 und D8 meiden, weil sie den Bootvorgang des ESP8266 beeinflussen.

**Aufbau pro Brett:** Grundplatte – Distanzstück – Wägezelle – Distanzstück – Deckplatte. Die Zelle unten an einem Ende
verschrauben, oben am anderen Ende. Gummifüsse unter die Grundplatte.

- **Abstand zwischen den Brettern:** einige Zentimeter. Die Bretter dürfen sich nie berühren, sonst misst eine Waage das Gewicht der anderen mit.
- **Kabel:** Die Kabel zwischen den Brettern locker führen, damit sie keine Last übertragen.
- **Position des Wemos:** daneben auf dem Boden, nicht auf einem Brett.

**Genauigkeit realistisch:** Das Rauschen liegt dank Mittelwert über die 1-Minuten-Ruhephase deutlich unter 1 g. Die Grenze ist
die Drift durch Temperatur und Dauerlast, bei günstigen Zellen einige Gramm über Stunden. Für einzelne Fressvorgänge (Minuten)
liegen **~1 g** drin. Langsame Drift ohne Sprung filtert das Backend heraus und zählt sie nicht als „gefressen“. Wenn das nicht reicht,
helfen Zellen der Klasse C3 (Zemic, Flintec, Bosche, ca. CHF 40–80 statt 5–10).

## Offene Punkte

- konkrete Wägezelle (günstig oder C3) und Bezugsquelle
- Toleranz für „stabil“ nach den ersten echten Messungen festlegen
- wie lange Rohdaten aufbewahrt werden
