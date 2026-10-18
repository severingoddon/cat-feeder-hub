# Design System – Schnauz-Buffet

Farbschema **„Erde“** (dunkel, warm), Palette von colorhunt: `#2C3639` `#3F4E4F` `#A27B5C` `#DCD7C9`.
Alle Farben sind CSS-Variablen in `web/src/styles.scss`. **Nie Hex-Werte direkt in Komponenten** – immer `var(--…)`.

## Farben

| Token | Wert | Verwendung |
|---|---|---|
| `--bg` | `#2c3639` | Seitenhintergrund, `theme-color` |
| `--glow` | `#3a4446` | weicher Lichtfleck im Hintergrund |
| `--panel` | `#313b3d` | grosse Container (Menükarte) |
| `--meal` | `#384446` | Karten im Normalzustand (serviert, pausiert) |
| `--surface` | `#3f4e4f` | hervorgehobene Karten, Toast, runde Icon-Buttons |
| `--soft` | `#4b5a5b` | dezente Flächen: sekundäre Buttons, Ringe, gestrichelte Linien |
| `--line` | `#5b6a6b` | Rahmen, Ghost-Buttons |
| `--copper` | `#a27b5c` | **Akzent**: „als Nächstes“, aktive Rahmen, Avatar-Ring, Bestätigungs-Buttons |
| `--sand` | `#dcd7c9` | Titel, Zeit-Pillen, Polaroid-Rahmen, Ende des Button-Verlaufs |
| `--ink` | `#dcd7c9` | Fliesstext |
| `--muted` | `#a8a596` | Nebeninfos, Status, Footer |
| `--on-sand` | `#2c3639` | Text auf Sand und auf Kupfer→Sand-Verlauf |
| `--on-copper` | `#ffffff` | Text auf reinem Kupfer |
| `--stripe-1` / `--stripe-2` | `#36413f` / `#443f38` | Streifen für „ausgesetzt“ |
| `--danger-bg` / `--danger` | `#4a2f2c` / `#f2b8ae` | Fehlerbanner |
| `--series-links` / `--series-rechts` | `#c47f3f` / `#3f93c4` | Diagramme: Farbe pro Automat (farbenblind-geprüft gegen `--panel`). Nur für Datenmarken, nie für Text |

## Regeln

- **Ein Akzent:** Kupfer markiert, was jetzt wichtig ist. Nicht für Deko verwenden.
- **Primärer Button:** `linear-gradient(135deg, var(--copper), var(--sand))` mit `color: var(--on-sand)`.
- **Sekundärer Button:** Fläche `--soft`, Text `--sand`. **Ghost:** transparent, gestrichelt `--line`, Text `--muted`.
- **Gefährliche Aktionen** (z. B. Füttern): zwei Tipps – erster Tipp färbt den Button primär („Wirklich? Tippen!“).
- **Zustände** über Form, nicht nur Farbe: serviert = `opacity: .6`, pausiert = gestrichelt, ausgesetzt = Streifen + durchgestrichen.
- **Schatten** sind schwarz (`rgba(0,0,0,.3)`), nie farbig.
- **Schriften:** Fredoka (UI), Caveat (Titel/Überschriften). Radius `--radius` (18px), Pillen 999px.
- **Ton:** verspielt, Katzen-Emojis und kurze, liebevolle Sprüche in Toasts.
