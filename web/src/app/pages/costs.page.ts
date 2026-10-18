import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { forkJoin } from 'rxjs';
import { RouterLink } from '@angular/router';
import { AnalysisResponse, CATS, FeederService, Food, GRAMS_PER_PORTION, Supply } from '../feeder.service';
import { UiService, formatDecimal, parseDecimal, pick } from '../ui.service';
import { isoDate, niceStep, parseDate } from './chart';

/** Ein Tag im Kostenverlauf. projected = Prognose aus dem Schnitt, noch nicht passiert. */
interface Point {
  date: string;
  grams: number;
  cost: number; // an diesem Tag
  total: number; // aufsummiert seit Beginn
  projected: boolean;
  today: boolean;
  x: number;
  y: number;
}

const HISTORY_DAYS = 90; // so viel holt die Seite vom Backend (Maximum dort)
const AVERAGE_DAYS = 30; // Schnitt über höchstens so viele ganze Tage
const FORECAST_DAYS = 30;
const DAYS_PER_MONTH = 365 / 12;
const PAD = { top: 16, right: 12, bottom: 24, left: 44 };
const CHART_HEIGHT = 220;

const SAVE_LINES = ['Preis notiert. Die Chefs zahlen trotzdem nichts 😼', 'Gespeichert! Die Buchhaltung ist zufrieden 🧾', 'Neuer Preis, gleiche Liebe 💕'];

const chf = (v: number) => v.toLocaleString('de-CH', { style: 'currency', currency: 'CHF' });

@Component({
  selector: 'app-costs-page',
  imports: [DecimalPipe, RouterLink],
  templateUrl: './costs.page.html',
  styleUrl: './costs.page.scss',
})
export class CostsPage {
  private api = inject(FeederService);
  readonly ui = inject(UiService);

  readonly chartHeight = CHART_HEIGHT;
  readonly pad = PAD;
  readonly cats = CATS;
  readonly chf = chf;
  readonly gramsPerPortion = GRAMS_PER_PORTION;
  readonly forecastDays = FORECAST_DAYS;

  data = signal<AnalysisResponse | null>(null);
  food = signal<Food | null>(null);
  supply = signal<Supply | null>(null);
  // Eingaben im Formular als Text (Komma oder Punkt erlaubt), gespeichert erst mit „Speichern“
  draft = signal<{ name: string; pricePerKg: string; packKg: string } | null>(null);
  loading = signal(true);
  saving = signal(false);
  error = signal<string | null>(null);
  selected = signal<string | null>(null);
  width = signal(500);

  private chartBox = viewChild<ElementRef<HTMLElement>>('chartBox');

  /** Formular als Zahlen gelesen; null, wenn etwas fehlt oder keine Zahl ist. */
  parsed = computed<Food | null>(() => {
    const d = this.draft();
    const price = d && parseDecimal(d.pricePerKg);
    const pack = d && parseDecimal(d.packKg);
    return d && price !== null && pack !== null ? { name: d.name.trim(), pricePerKg: price, packKg: pack } : null;
  });

  dirty = computed(() => {
    const f = this.food();
    const d = this.draft();
    const p = this.parsed();
    return !!f && !!d && (!p || f.name !== p.name || f.pricePerKg !== p.pricePerKg || f.packKg !== p.packKg);
  });

  valid = computed(() => {
    const p = this.parsed();
    return !!p && p.name.length > 0 && p.pricePerKg > 0 && p.pricePerKg <= 500 && p.packKg > 0 && p.packKg <= 50;
  });

  /** Gramm pro Tag (beide Automaten) seit dem ersten Eintrag im Verlauf. */
  days = computed(() => {
    const data = this.data();
    if (!data?.since) return [];
    const today = isoDate(new Date());
    return data.days
      .filter((d) => d.date >= data.since!)
      .map((d) => ({
        date: d.date,
        today: d.date === today,
        first: d.date === data.since,
        grams: Object.values(d.feeders).reduce((s, c) => s + c.portions, 0) * GRAMS_PER_PORTION,
        skipped: Object.values(d.feeders).reduce((s, c) => s + c.skipped, 0) * GRAMS_PER_PORTION,
        extra: Object.values(d.feeders).reduce((s, c) => s + c.extra, 0) * GRAMS_PER_PORTION,
      }));
  });

  pricePerGram = computed(() => (this.food()?.pricePerKg ?? 0) / 1000);

  /** Kennzahlen; der Schnitt nimmt nur ganze Tage (ohne heute und ohne den Einrichtungstag). */
  stats = computed(() => {
    const days = this.days();
    const price = this.pricePerGram();
    const food = this.food();
    const full = days.filter((d) => !d.today && !d.first).slice(-AVERAGE_DAYS);
    const gramsPerDay = full.length ? full.reduce((s, d) => s + d.grams, 0) / full.length : 0;
    const perDay = gramsPerDay * price;
    const sum = (f: (d: (typeof days)[number]) => number) => days.reduce((s, d) => s + f(d), 0);
    const packDays = gramsPerDay && food ? (food.packKg * 1000) / gramsPerDay : null;
    return {
      fullDays: full.length,
      gramsPerDay: Math.round(gramsPerDay),
      perDay,
      perMonth: perDay * DAYS_PER_MONTH,
      perYear: perDay * 365,
      perCatMonth: (perDay * DAYS_PER_MONTH) / CATS,
      kgPerMonth: (gramsPerDay * DAYS_PER_MONTH) / 1000,
      today: (days.find((d) => d.today)?.grams ?? 0) * price,
      total: sum((d) => d.grams) * price,
      perPortion: GRAMS_PER_PORTION * price,
      packPrice: food ? food.packKg * food.pricePerKg : 0,
      packDays,
      packsPerYear: packDays ? 365 / packDays : null,
      saved: sum((d) => d.skipped) * price,
      extra: sum((d) => d.extra) * price,
    };
  });

  // ---------- Kostenverlauf: aufsummiert, dazu Prognose ----------

  points = computed<Point[]>(() => {
    const days = this.days();
    if (!days.length) return [];
    const price = this.pricePerGram();
    const perDay = this.stats().perDay;
    const raw: Omit<Point, 'x' | 'y'>[] = [];
    let total = 0;
    for (const d of days) {
      total += d.grams * price;
      raw.push({ date: d.date, grams: d.grams, cost: d.grams * price, total, projected: false, today: d.today });
    }
    // Prognose mit dem Tagesschnitt. Heute ist noch nicht fertig, darum zählt heute als ganzer Schnitt-Tag.
    const last = days[days.length - 1];
    let projected = last.today ? total - last.grams * price + perDay : total;
    const start = parseDate(last.date);
    for (let i = 1; i <= FORECAST_DAYS; i++) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      projected += perDay;
      raw.push({ date: isoDate(date), grams: 0, cost: perDay, total: projected, projected: true, today: false });
    }
    const plotW = this.width() - PAD.left - PAD.right;
    const step = plotW / Math.max(raw.length - 1, 1);
    const yMax = this.yMax(raw.map((p) => p.total));
    return raw.map((p, i) => ({ ...p, x: PAD.left + i * step, y: this.y(p.total, yMax) }));
  });

  yTicks = computed(() => {
    const max = this.yMax(this.points().map((p) => p.total));
    const step = niceStep(max);
    return Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step).map((v) => ({ v, y: this.y(v, max) }));
  });

  actual = computed(() => this.points().filter((p) => !p.projected));

  /** Prognose beginnt am letzten echten Punkt, damit die Linien aneinander anschliessen. */
  forecast = computed(() => {
    const pts = this.points();
    const firstProjected = pts.findIndex((p) => p.projected);
    return firstProjected > 0 ? pts.slice(firstProjected - 1) : [];
  });

  linePath = computed(() => this.path(this.actual()));
  areaPath = computed(() => {
    const pts = this.actual();
    if (!pts.length) return '';
    const base = this.y(0, this.yMax(this.points().map((p) => p.total)));
    return `${this.path(pts)}L${pts[pts.length - 1].x},${base}L${pts[0].x},${base}Z`;
  });
  forecastPath = computed(() => this.path(this.forecast()));

  /** x-Beschriftung: erster Tag, heute, Ende der Prognose. */
  xLabels = computed(() => {
    const pts = this.points();
    if (!pts.length) return [];
    const today = pts.find((p) => p.today) ?? this.actual()[this.actual().length - 1];
    const first = pts[0];
    const end = pts[pts.length - 1];
    const labels = [
      { x: first.x, text: this.short(first.date), anchor: 'start' },
      { x: today.x, text: 'heute', anchor: 'middle' },
      { x: end.x, text: this.short(end.date), anchor: 'end' },
    ];
    // zu nah beieinander → mittlere weglassen, statt sie überlappen zu lassen
    return labels.filter((l, i) => i !== 1 || (today.x - first.x > 40 && end.x - today.x > 40));
  });

  endPoint = computed(() => {
    const f = this.forecast();
    return f.length ? f[f.length - 1] : null;
  });

  todayPoint = computed(() => {
    const a = this.actual();
    return a.length ? a[a.length - 1] : null;
  });

  selectedPoint = computed(() => this.points().find((p) => p.date === this.selected()) ?? this.todayPoint());

  constructor() {
    this.load();
    const observer = new ResizeObserver(([entry]) => this.width.set(Math.max(280, entry.contentRect.width)));
    effect(() => {
      const box = this.chartBox();
      if (box) observer.observe(box.nativeElement);
    });
    inject(DestroyRef).onDestroy(() => observer.disconnect());
  }

  load(): void {
    this.loading.set(true);
    forkJoin([this.api.analysis(HISTORY_DAYS), this.api.food(), this.api.supply()]).subscribe({
      next: ([data, food, supply]) => {
        this.data.set(data);
        this.supply.set(supply);
        this.food.set(food);
        this.draft.set(this.toDraft(food));
        this.error.set(data.error ? 'Cloud gerade nicht erreichbar, rechne mit dem letzten Stand 🙀' : null);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Backend nicht erreichbar 🙀');
        this.loading.set(false);
      },
    });
  }

  // Der Text bleibt so, wie getippt – nicht zurückschreiben, sonst verschwindet z. B. das Komma in „16,“
  edit(field: 'name' | 'pricePerKg' | 'packKg', value: string): void {
    const d = this.draft();
    if (d) this.draft.set({ ...d, [field]: value });
  }

  reset(): void {
    const f = this.food();
    if (f) this.draft.set(this.toDraft(f));
  }

  save(event: MouseEvent): void {
    const p = this.parsed();
    if (!p || !this.valid() || this.saving()) return;
    this.saving.set(true);
    this.api.saveFood(p).subscribe({
      next: (food) => {
        this.food.set(food);
        this.draft.set(this.toDraft(food));
        this.saving.set(false);
        this.ui.showToast(pick(SAVE_LINES));
        this.ui.burst(event, ['💰', '🐟', '✨']);
      },
      error: (e) => {
        this.saving.set(false);
        this.ui.showToast(`Hoppla, speichern ging nicht 🙀 (${e.error?.detail?.[0]?.msg ?? e.status})`);
      },
    });
  }

  private toDraft(food: Food) {
    return { name: food.name, pricePerKg: formatDecimal(food.pricePerKg), packKg: formatDecimal(food.packKg) };
  }

  long(date: string): string {
    return parseDate(date).toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'numeric' });
  }

  day(iso: string): string {
    return new Date(iso).toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'numeric' });
  }

  short(date: string): string {
    return parseDate(date).toLocaleDateString('de-CH', { day: 'numeric', month: 'numeric' });
  }

  private path(pts: Point[]): string {
    return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join('');
  }

  private yMax(values: number[]): number {
    const top = Math.max(...values, 1) * 1.08;
    const step = niceStep(top);
    return Math.ceil(top / step) * step;
  }

  private y(v: number, max: number): number {
    return PAD.top + (1 - v / max) * (CHART_HEIGHT - PAD.top - PAD.bottom);
  }
}
