import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { AnalysisResponse, FeederService, GRAMS_PER_BOWL, GRAMS_PER_PORTION } from '../feeder.service';
import { UiService } from '../ui.service';

/** Ein Tag im Säulendiagramm, alles schon in Gramm. */
interface Day {
  date: string; // YYYY-MM-DD
  label: string; // Achsenbeschriftung
  long: string; // für Readout und Tabelle
  today: boolean;
  feeders: { key: string; name: string; grams: number; extra: number; skipped: number }[];
  total: number;
  extra: number;
  skipped: number;
}

interface Segment {
  key: string;
  path: string;
  skipped: boolean;
}

interface Column {
  day: Day;
  x: number; // linke Kante des Bandes (Trefferfläche)
  center: number;
  segments: Segment[];
}

interface Dot {
  id: string;
  feeder: string;
  name: string;
  x: number;
  y: number;
  kind: 'plan' | 'extra' | 'skipped';
  time: string;
  grams: number;
}

const RANGES = [7, 14, 30];
const RHYTHM_DAYS = 7;
const BAR_MAX = 24;
const GAP = 2; // Oberflächen-Lücke zwischen gestapelten Segmenten
const PAD = { top: 12, right: 8, bottom: 24, left: 36 };
const CHART_HEIGHT = 210;
const RHYTHM_ROW = 30;

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (s: string) => new Date(`${s}T12:00:00`);

/** Säule mit 4px-Rundung oben, eckig an der Grundlinie. */
function bar(x: number, y: number, w: number, h: number, round: boolean): string {
  const r = round ? Math.min(4, h, w / 2) : 0;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Schöne Schrittweite für die y-Achse (10/20/25/50/100 …). */
function niceStep(max: number): number {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((f) => f * mag >= raw) ?? 10) * mag;
}

@Component({
  selector: 'app-analysis-page',
  templateUrl: './analysis.page.html',
  styleUrl: './analysis.page.scss',
})
export class AnalysisPage {
  private api = inject(FeederService);
  readonly ui = inject(UiService);

  readonly ranges = RANGES;
  readonly chartHeight = CHART_HEIGHT;
  readonly pad = PAD;
  readonly rhythmRow = RHYTHM_ROW;
  readonly gramsPerPortion = GRAMS_PER_PORTION;
  readonly gramsPerBowl = GRAMS_PER_BOWL;

  range = signal(14);
  data = signal<AnalysisResponse | null>(null);
  loading = signal(true);
  error = signal<string | null>(null);
  selected = signal<string | null>(null); // Datum im Säulendiagramm
  selectedDot = signal<string | null>(null);
  width = signal(500);

  private chartBox = viewChild<ElementRef<HTMLElement>>('chartBox');

  feeders = computed(() => this.data()?.feeders ?? []);

  /** Soll laut aktuellem Plan, beide Automaten zusammen. */
  planGrams = computed(() => this.feeders().reduce((sum, f) => sum + f.planPortions, 0) * GRAMS_PER_PORTION);

  /** Tage im gewählten Zeitraum, ohne die Zeit vor dem ersten Eintrag im Verlauf. */
  days = computed<Day[]>(() => {
    const data = this.data();
    if (!data) return [];
    const today = isoDate(new Date());
    const names = Object.fromEntries(data.feeders.map((f) => [f.key, f.name]));
    return data.days
      .filter((d) => data.since && d.date >= data.since)
      .map((d) => {
        const date = parseDate(d.date);
        const feeders = data.feeders.map((f) => {
          const c = d.feeders[f.key] ?? { portions: 0, extra: 0, skipped: 0 };
          return {
            key: f.key,
            name: names[f.key],
            grams: c.portions * GRAMS_PER_PORTION,
            extra: c.extra * GRAMS_PER_PORTION,
            skipped: c.skipped * GRAMS_PER_PORTION,
          };
        });
        const isToday = d.date === today;
        return {
          date: d.date,
          label: isToday ? 'heute' : date.toLocaleDateString('de-CH', { weekday: 'short' }).replace('.', ''),
          long: date.toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'numeric' }),
          today: isToday,
          feeders,
          total: feeders.reduce((s, f) => s + f.grams, 0),
          extra: feeders.reduce((s, f) => s + f.extra, 0),
          skipped: feeders.reduce((s, f) => s + f.skipped, 0),
        };
      });
  });

  /** Kennzahlen: heute, Schnitt der abgeschlossenen Tage, Ausgesetztes und Extras im Zeitraum. */
  stats = computed(() => {
    const days = this.days();
    const today = days.find((d) => d.today);
    // Ganze Tage: ohne heute und ohne den ersten Tag im Verlauf (Einrichtung, nur angebrochen)
    const done = days.filter((d) => !d.today && d.date !== this.data()?.since);
    const sum = (list: Day[], f: (d: Day) => number) => list.reduce((s, d) => s + f(d), 0);
    const portions = (grams: number) => Math.round(grams / GRAMS_PER_PORTION);
    return {
      today: today?.total ?? 0,
      average: done.length ? Math.round(sum(done, (d) => d.total) / done.length) : null,
      doneDays: done.length,
      skipped: sum(days, (d) => d.skipped),
      skippedCount: portions(sum(days, (d) => d.skipped)),
      extra: sum(days, (d) => d.extra),
      extraCount: portions(sum(days, (d) => d.extra)),
    };
  });

  // ---------- Säulendiagramm ----------

  yMax = computed(() => {
    const top = Math.max(this.planGrams(), ...this.days().map((d) => d.total + d.skipped), 1);
    const step = niceStep(top * 1.08);
    return Math.ceil((top * 1.08) / step) * step;
  });

  yTicks = computed(() => {
    const step = niceStep(this.yMax());
    return Array.from({ length: Math.round(this.yMax() / step) + 1 }, (_, i) => i * step).map((v) => ({ v, y: this.y(v) }));
  });

  planY = computed(() => this.y(this.planGrams()));

  columns = computed<Column[]>(() => {
    const days = this.days();
    const plotW = this.width() - PAD.left - PAD.right;
    const band = plotW / Math.max(days.length, 1);
    const w = Math.min(BAR_MAX, band * 0.62);
    return days.map((day, i) => {
      const x = PAD.left + i * band;
      const bx = x + (band - w) / 2;
      const parts = [
        ...day.feeders.filter((f) => f.grams).map((f) => ({ key: f.key, grams: f.grams, skipped: false })),
        ...(day.skipped ? [{ key: 'skipped', grams: day.skipped, skipped: true }] : []),
      ];
      let base = 0;
      const segments = parts.map((p, j) => {
        const y0 = this.y(base);
        const y1 = this.y(base + p.grams);
        base += p.grams;
        const h = Math.max(y0 - y1 - (j ? GAP : 0), 1);
        return { key: p.key, skipped: p.skipped, path: bar(bx, y1, w, h, j === parts.length - 1) };
      });
      return { day, x, center: x + band / 2, segments };
    });
  });

  /** Beschriftung nur für jede n-te Säule, damit nichts überlappt; heute immer. */
  labelEvery = computed(() => Math.ceil(this.days().length / Math.max(1, Math.floor((this.width() - PAD.left) / 34))));

  selectedDay = computed(() => {
    const days = this.days();
    return days.find((d) => d.date === this.selected()) ?? days[days.length - 1] ?? null;
  });

  // ---------- Tagesrhythmus ----------

  rhythmDays = computed(() => this.days().slice(-RHYTHM_DAYS).reverse());

  rhythmHeight = computed(() => this.rhythmDays().length * RHYTHM_ROW + 24);

  hourTicks = computed(() => [0, 6, 12, 18, 24].map((h) => ({ h, x: this.hourX(h) })));

  dots = computed<Dot[]>(() => {
    const data = this.data();
    if (!data) return [];
    const rows = new Map(this.rhythmDays().map((d, i) => [d.date, i]));
    const keys = data.feeders.map((f) => f.key);
    const names = Object.fromEntries(data.feeders.map((f) => [f.key, f.name]));
    const place = (feeder: string, ts: string) => {
      const row = rows.get(ts.slice(0, 10));
      if (row === undefined) return null;
      const t = new Date(ts);
      const offset = (keys.indexOf(feeder) - (keys.length - 1) / 2) * 9; // links oben, rechts unten
      return {
        x: this.hourX(t.getHours() + t.getMinutes() / 60),
        y: row * RHYTHM_ROW + RHYTHM_ROW / 2 + offset,
        time: `${pad(t.getHours())}:${pad(t.getMinutes())}`,
      };
    };
    const fed = data.events.flatMap((e, i) => {
      const p = place(e.feeder, e.ts);
      return p ? [{ id: `f${i}`, feeder: e.feeder, name: names[e.feeder], ...p, grams: e.portions * GRAMS_PER_PORTION,
        kind: e.extra ? ('extra' as const) : ('plan' as const) }] : [];
    });
    const skipped = data.skips.flatMap((s, i) => {
      const p = place(s.feeder, s.ts);
      return p ? [{ id: `s${i}`, feeder: s.feeder, name: names[s.feeder], ...p, grams: s.portions * GRAMS_PER_PORTION,
        kind: 'skipped' as const }] : [];
    });
    return [...skipped, ...fed];
  });

  activeDot = computed(() => this.dots().find((d) => d.id === this.selectedDot()) ?? null);

  constructor() {
    effect(() => this.load(this.range()));
    const observer = new ResizeObserver(([entry]) => this.width.set(Math.max(280, entry.contentRect.width)));
    effect(() => {
      const box = this.chartBox();
      if (box) observer.observe(box.nativeElement);
    });
    inject(DestroyRef).onDestroy(() => observer.disconnect());
  }

  load(days = this.range()): void {
    this.loading.set(true);
    this.api.analysis(days).subscribe({
      next: (res) => {
        this.data.set(res);
        this.error.set(res.error ? `Cloud gerade nicht erreichbar, zeige den letzten Stand 🙀` : null);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Backend nicht erreichbar 🙀');
        this.loading.set(false);
      },
    });
  }

  color(key: string): string {
    return `var(--series-${key})`;
  }

  dayDate(s: string | null): string {
    return s ? parseDate(s).toLocaleDateString('de-CH', { day: 'numeric', month: 'numeric' }) : '';
  }

  syncTime(s: string | null): string {
    return s ? new Date(s).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : '–';
  }

  private y(grams: number): number {
    return PAD.top + (1 - grams / this.yMax()) * (CHART_HEIGHT - PAD.top - PAD.bottom);
  }

  private hourX(h: number): number {
    return PAD.left + (h / 24) * (this.width() - PAD.left - PAD.right);
  }
}
