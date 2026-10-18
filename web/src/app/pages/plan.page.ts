import { Component, DestroyRef, HostListener, computed, inject, signal } from '@angular/core';
import { forkJoin } from 'rxjs';
import { Feeder, FeederService, GRAMS_PER_PORTION, Meal, MealInput } from '../feeder.service';
import { UiService, pick } from '../ui.service';

// Gleiche Grenzen wie im Backend (server.py)
const MAX_MEALS = 10;
const MAX_PORTIONS = 12;

interface Row {
  time: string;
  cells: (Meal | null)[]; // eine Zelle pro Gerät
}

/** Was gerade im Editor bearbeitet wird. id = null → neue Zeit. */
interface Draft {
  feeder: Feeder;
  id: string | null;
  hour: number;
  minute: number;
  portions: number;
  both: boolean; // neue Zeit auch beim anderen Automaten anlegen
}

const ADD_LINES = ['Neue Mahlzeit auf der Karte! 🎉', 'Eingetragen. Die Chefs freuen sich schon 💕', 'Zusätzlicher Termin im Kalender der Chefs 😻'];
const EDIT_LINES = ['Notiert! Die Küche passt den Dienstplan an 📝', 'Plan aktualisiert – die Chefs nicken zufrieden 😼', 'Geändert. Bitte pünktlich servieren!'];
const DELETE_LINES = ["Gestrichen. Die Chefs haben's gesehen 😾", 'Weg damit. Hoffentlich merkt es keiner …', 'Mahlzeit von der Karte genommen 😿'];

const pad = (n: number) => String(n).padStart(2, '0');

@Component({
  selector: 'app-plan-page',
  templateUrl: './plan.page.html',
  styleUrl: './plan.page.scss',
})
export class PlanPage {
  private api = inject(FeederService);
  readonly ui = inject(UiService);

  readonly maxMeals = MAX_MEALS;
  readonly maxPortions = MAX_PORTIONS;
  readonly gramsPerPortion = GRAMS_PER_PORTION;
  readonly quickTimes = ['06:30', '07:00', '12:00', '17:30', '18:00', '22:00'];

  feeders = signal<Feeder[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  draft = signal<Draft | null>(null);
  saving = signal(false);
  armedDelete = signal(false);
  fresh = signal<string | null>(null); // "feeder|HH:MM" frisch gespeichert → kurz hervorheben

  rows = computed<Row[]>(() => {
    const feeders = this.feeders();
    const times = [...new Set(feeders.flatMap((f) => f.meals.map((m) => m.id)))].sort();
    return times.map((time) => ({ time, cells: feeders.map((f) => f.meals.find((m) => m.id === time) ?? null) }));
  });

  totals = computed(() =>
    this.feeders().map((f) => ({
      meals: f.meals.length,
      portions: f.meals.filter((m) => m.enabled).reduce((sum, m) => sum + m.portions, 0),
    })),
  );

  draftTime = computed(() => {
    const d = this.draft();
    return d ? `${pad(d.hour)}:${pad(d.minute)}` : '';
  });

  otherFeeder = computed(() => {
    const d = this.draft();
    return d ? this.feeders().find((f) => f.key !== d.feeder.key) ?? null : null;
  });

  /** Fehlermeldung, falls die Eingabe so nicht gespeichert werden kann. */
  conflict = computed<string | null>(() => {
    const d = this.draft();
    if (!d) return null;
    const time = this.draftTime();
    const targets = !d.id && d.both ? this.feeders() : this.feeders().filter((f) => f.key === d.feeder.key);
    for (const f of targets) {
      if (f.meals.some((m) => m.id === time && m.id !== d.id)) {
        return `Um ${time} gibt's bei ${f.name} schon Futter. Bearbeite lieber die bestehende Zeit.`;
      }
      if (!d.id && f.meals.length >= MAX_MEALS) {
        return `${f.name} hat schon ${MAX_MEALS} Zeiten – mehr geht nicht.`;
      }
    }
    return null;
  });

  private armTimer?: ReturnType<typeof setTimeout>;
  private freshTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.reload();
    const onVisible = () => document.visibilityState === 'visible' && !this.draft() && this.reload();
    document.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(this.armTimer);
      clearTimeout(this.freshTimer);
    });
  }

  reload(refresh = false): void {
    if (refresh) this.loading.set(true);
    this.api.load(refresh).subscribe({
      next: (res) => {
        this.feeders.set(res.feeders);
        this.error.set(res.feeders.find((f) => f.error)?.error ?? null);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Backend nicht erreichbar 🙀');
        this.loading.set(false);
      },
    });
  }

  // ---------- Editor ----------

  edit(feeder: Feeder, meal: Meal): void {
    this.open({ feeder, id: meal.id, hour: meal.hour, minute: meal.minute, portions: meal.portions, both: false });
  }

  add(feeder: Feeder, time = '08:00'): void {
    const [hour, minute] = time.split(':').map(Number);
    this.open({ feeder, id: null, hour, minute, portions: 1, both: false });
  }

  @HostListener('document:keydown.escape')
  close(): void {
    if (this.saving()) return;
    this.draft.set(null);
    this.armedDelete.set(false);
  }

  setTime(value: string): void {
    const [hour, minute] = value.split(':').map(Number);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return;
    this.patch({ hour, minute });
  }

  stepPortions(delta: number): void {
    const d = this.draft();
    if (d) this.patch({ portions: Math.min(MAX_PORTIONS, Math.max(1, d.portions + delta)) });
  }

  setBoth(both: boolean): void {
    this.patch({ both });
  }

  save(event: MouseEvent): void {
    const d = this.draft();
    if (!d || this.conflict() || this.saving()) return;
    const input: MealInput = { hour: d.hour, minute: d.minute, portions: d.portions };
    const targets = !d.id && d.both ? this.feeders() : [d.feeder];
    const time = this.draftTime();
    this.saving.set(true);
    forkJoin(targets.map((f) => (d.id ? this.api.editMeal(f.key, d.id, input) : this.api.addMeal(f.key, input)))).subscribe({
      next: () => {
        this.saving.set(false);
        this.close();
        this.highlight(`${d.feeder.key}|${time}`);
        this.ui.showToast(`${targets.map((f) => f.name).join(' & ')}, ${time}: ${pick(d.id ? EDIT_LINES : ADD_LINES)}`);
        this.ui.burst(event, ['💕', '🐟', '✨']);
        this.reload();
      },
      error: (e) => this.failed(e),
    });
  }

  // Erster Tipp schärft den Knopf, zweiter Tipp löscht – wie beim manuellen Füttern.
  remove(event: MouseEvent): void {
    const d = this.draft();
    if (!d?.id || this.saving()) return;
    clearTimeout(this.armTimer);
    if (!this.armedDelete()) {
      this.armedDelete.set(true);
      this.armTimer = setTimeout(() => this.armedDelete.set(false), 4000);
      return;
    }
    this.saving.set(true);
    this.api.deleteMeal(d.feeder.key, d.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.close();
        this.ui.showToast(`${d.feeder.name}, ${d.id}: ${pick(DELETE_LINES)}`);
        this.ui.burst(event, ['😿', '💔', '🐾']);
        this.reload();
      },
      error: (e) => this.failed(e),
    });
  }

  portions(n: number): number[] {
    return Array.from({ length: Math.min(n, 6) });
  }

  isFresh(feeder: Feeder, time: string): boolean {
    return this.fresh() === `${feeder.key}|${time}`;
  }

  private open(draft: Draft): void {
    clearTimeout(this.armTimer);
    this.armedDelete.set(false);
    this.draft.set(draft);
  }

  private patch(changes: Partial<Draft>): void {
    this.draft.update((d) => (d ? { ...d, ...changes } : d));
  }

  private highlight(id: string): void {
    clearTimeout(this.freshTimer);
    this.fresh.set(id);
    this.freshTimer = setTimeout(() => this.fresh.set(null), 1600);
  }

  private failed(e: { error?: { detail?: unknown }; status?: number }): void {
    this.saving.set(false);
    const detail = typeof e.error?.detail === 'string' ? e.error.detail : e.status;
    this.ui.showToast(`Hoppla, das hat nicht geklappt 🙀 (${detail})`);
    this.reload(); // bei „beide Automaten“ kann einer schon gespeichert haben
  }
}
