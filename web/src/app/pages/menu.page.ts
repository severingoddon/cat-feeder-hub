import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FeederService, Feeder, GRAMS_PER_BOWL, GRAMS_PER_PORTION, Meal, Supply } from '../feeder.service';
import { SupplyAlertComponent } from '../supply/supply-alert.component';
import { UiService, pick } from '../ui.service';

type MealState = 'served' | 'upcoming' | 'skipped' | 'paused';

interface Cell {
  feeder: Feeder;
  meal: Meal;
  state: MealState;
  tomorrow: boolean; // nächste Ausführung ist erst morgen
}

interface Row {
  time: string;
  cells: (Cell | null)[]; // eine Zelle pro Gerät, null = keine Mahlzeit um diese Zeit
  isNext: boolean;
}

const SKIP_LINES = [
  'Okay, Diät-Modus aktiviert 😿',
  'Heute bleibt der Napf leer. Sorry, Schnurrbart!',
  'Notiert. Die Chefs werden sich beschweren.',
  'Ausgesetzt! Jetzt bitte extra kuscheln.',
  'Erledigt – Mitleidsblick in 3, 2, 1 …',
];
const FEED_LINES = ['Snack ist unterwegs! 🐟', 'Eine Portion Extraliebe serviert 💕', 'Bonusrunde! Die Chefs sind begeistert 😻'];
const UNSKIP_LINES = ['Juhu, Futter ist zurück! 🎉', 'Gnade gewährt. Napf wird wieder gefüllt.', 'Die Chefs sind wieder happy 💕'];

@Component({
  selector: 'app-menu-page',
  imports: [SupplyAlertComponent],
  templateUrl: './menu.page.html',
  styleUrl: './menu.page.scss',
})
export class MenuPage {
  private api = inject(FeederService);
  readonly ui = inject(UiService);

  feeders = signal<Feeder[]>([]);
  supply = signal<Supply | null>(null);
  now = signal(new Date());
  loading = signal(true);
  error = signal<string | null>(null);
  busy = signal<string | null>(null); // "feeder|meal" während Request läuft
  armedFeed = signal<string | null>(null); // Gerät, das auf die Bestätigung für die manuelle Fütterung wartet

  rows = computed<Row[]>(() => {
    const feeders = this.feeders();
    const now = this.now();
    const times = [...new Set(feeders.flatMap((f) => f.meals.map((m) => m.id)))].sort();
    const rows = times.map((time) => ({
      time,
      isNext: false,
      cells: feeders.map((feeder) => {
        const meal = feeder.meals.find((m) => m.id === time);
        return meal ? { feeder, meal, ...this.describe(meal, now) } : null;
      }),
    }));
    const next = rows.find((r) => r.cells.some((c) => c && c.state === 'upcoming' && !c.tomorrow));
    if (next) next.isNext = true;
    return rows;
  });

  totals = computed(() =>
    this.feeders().map((f) => {
      const portions = f.meals.filter((m) => m.enabled).reduce((sum, m) => sum + m.portions, 0);
      return {
        key: f.key,
        portions,
        grams: portions * GRAMS_PER_PORTION,
        gramsPerBowl: portions * GRAMS_PER_BOWL,
        skipped: f.meals.filter((m) => m.skippedFor).length,
      };
    }),
  );

  greeting = computed(() => {
    const h = this.now().getHours();
    if (h < 5) return 'Psst, die Chefs schlafen 🌙';
    if (h < 11) return 'Guten Morgen, Futterpersonal ☀️';
    if (h < 17) return 'Mittagsschicht im Schnauz-Buffet 🍽️';
    if (h < 22) return 'Guten Abend, ihr Lieblingsmenschen 💕';
    return 'Spätschicht – noch ein Snack? 🌙';
  });

  private armTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.reload();
    const tick = setInterval(() => this.now.set(new Date()), 30_000);
    const poll = setInterval(() => this.reload(), 60_000);
    const onVisible = () => document.visibilityState === 'visible' && this.reload();
    document.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(tick);
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
    });
  }

  reload(refresh = false): void {
    if (refresh) this.loading.set(true);
    this.api.supply().subscribe({ next: (s) => this.supply.set(s), error: () => this.supply.set(null) });
    this.api.load(refresh).subscribe({
      next: (res) => {
        this.feeders.set(res.feeders);
        this.now.set(new Date());
        this.error.set(res.feeders.find((f) => f.error)?.error ?? null);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Backend nicht erreichbar 🙀');
        this.loading.set(false);
      },
    });
  }

  toggleSkip(cell: Cell, event: MouseEvent): void {
    const id = `${cell.feeder.key}|${cell.meal.id}`;
    if (this.busy()) return;
    this.busy.set(id);
    const undo = cell.state === 'skipped';
    const req = undo ? this.api.unskip(cell.feeder.key, cell.meal.id) : this.api.skip(cell.feeder.key, cell.meal.id);
    req.subscribe({
      next: () => {
        this.busy.set(null);
        const lines = undo ? UNSKIP_LINES : SKIP_LINES;
        this.ui.showToast(`${cell.feeder.name}, ${cell.meal.id}: ${pick(lines)}`);
        this.ui.burst(event, undo ? ['💕', '🐟', '✨'] : ['😿', '💔', '🐾']);
        this.reload();
      },
      error: (e) => {
        this.busy.set(null);
        this.ui.showToast(`Hoppla, das Gerät hat nicht reagiert 🙀 (${e.error?.detail ?? e.status})`);
      },
    });
  }

  // Erster Tipp schärft den Knopf, zweiter Tipp füttert – damit nicht aus Versehen Futter rausfällt.
  feed(feeder: Feeder, event: MouseEvent): void {
    if (this.busy()) return;
    clearTimeout(this.armTimer);
    if (this.armedFeed() !== feeder.key) {
      this.armedFeed.set(feeder.key);
      this.armTimer = setTimeout(() => this.armedFeed.set(null), 4000);
      return;
    }
    this.armedFeed.set(null);
    this.busy.set(`${feeder.key}|feed`);
    this.api.feed(feeder.key).subscribe({
      next: () => {
        this.busy.set(null);
        this.ui.showToast(`${feeder.name}: ${pick(FEED_LINES)}`);
        this.ui.burst(event, ['🐟', '💕', '✨']);
      },
      error: (e) => {
        this.busy.set(null);
        this.ui.showToast(`Hoppla, das Gerät hat nicht reagiert 🙀 (${e.error?.detail ?? e.status})`);
      },
    });
  }

  isBusy(cell: Cell): boolean {
    return this.busy() === `${cell.feeder.key}|${cell.meal.id}`;
  }

  portions(n: number): number[] {
    return Array.from({ length: Math.min(n, 6) });
  }

  private describe(meal: Meal, now: Date): Pick<Cell, 'state' | 'tomorrow'> {
    const today = new Date(now);
    today.setHours(meal.hour, meal.minute, 0, 0);
    const passed = today <= now;
    if (meal.skippedFor) {
      const tomorrow = new Date(meal.skippedFor).toDateString() !== now.toDateString();
      return { state: 'skipped', tomorrow };
    }
    if (!meal.enabled) return { state: 'paused', tomorrow: passed };
    return passed ? { state: 'served', tomorrow: true } : { state: 'upcoming', tomorrow: false };
  }
}
