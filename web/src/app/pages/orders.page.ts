import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { forkJoin } from 'rxjs';
import { FeederService, Food, Supply, SupplyEntry } from '../feeder.service';
import { SupplyAlertComponent } from '../supply/supply-alert.component';
import { UiService, formatDecimal, parseDecimal, pick } from '../ui.service';
import { isoDate } from './chart';

const ORDER_LINES = ['Bestellung notiert! Die Chefs reiben sich die Pfoten 😻', 'Nachschub ist unterwegs 📦', 'Eingetragen. Das Buffet bleibt offen 🐟'];
const ARRIVED_LINES = ['Futter ist da! Die Chefs inspizieren die Lieferung 😼', 'Angekommen – Vorrat aufgefüllt 📦', 'Lieferung verbucht. Buffet gesichert 🐟'];
const STOCK_LINES = ['Vorrat gezählt, danke! 🧮', 'Notiert – die Rechnung stimmt jetzt wieder 😼'];
const MAX_PACKS = 20;

const chf = (v: number) => v.toLocaleString('de-CH', { style: 'currency', currency: 'CHF' });
const day = (iso: string) => new Date(iso).toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'numeric' });

@Component({
  selector: 'app-orders-page',
  imports: [DecimalPipe, SupplyAlertComponent],
  templateUrl: './orders.page.html',
  styleUrl: './orders.page.scss',
})
export class OrdersPage {
  private api = inject(FeederService);
  readonly ui = inject(UiService);

  readonly maxPacks = MAX_PACKS;
  readonly today = isoDate(new Date());
  readonly chf = chf;
  readonly day = day;

  supply = signal<Supply | null>(null);
  food = signal<Food | null>(null);
  loading = signal(true);
  saving = signal(false);
  error = signal<string | null>(null);
  armedDelete = signal<number | null>(null);

  // Formular „Bestellung“
  orderDate = signal(this.today);
  packs = signal(2);
  // Formular „Vorrat zählen“
  stockText = signal(''); // so wie getippt, Komma oder Punkt; vorbelegt mit dem berechneten Vorrat
  private stockEdited = false; // nach eigener Eingabe nicht mehr mit dem berechneten Wert überschreiben
  stockKg = computed(() => parseDecimal(this.stockText()));

  packKg = computed(() => this.food()?.packKg ?? 1.4);
  orderKg = computed(() => this.packs() * this.packKg());
  orderPrice = computed(() => this.orderKg() * (this.food()?.pricePerKg ?? 0));

  /** Abgerundet – lieber einen Tag zu früh bestellen. Gleich wie im roten Hinweis. */
  daysLeft = computed(() => Math.floor(this.supply()?.daysLeft ?? 0));

  /** Vorrat jetzt in Packungen, für die Anzeige. */
  levelPacks = computed(() => (this.supply()?.level ?? 0) / 1000 / this.packKg());

  /** Die wichtigen Daten in zeitlicher Reihenfolge. */
  milestones = computed(() => {
    const s = this.supply();
    if (!s?.known || !s.runsOut) return [];
    const now = Date.now();
    return [
      ...(s.pending ?? []).map((p) => ({ icon: '📦', label: `Lieferung erwartet (${this.kg(p.grams)} kg)`, at: p.arrives, order: p.id })),
      { icon: '🛒', label: 'Erinnerung zum Bestellen', at: s.orderBy!, order: null },
      { icon: '⏰', label: `spätestens bestellen (${s.deliveryDays} Tage Lieferfrist)`, at: s.lastChance!, order: null },
      { icon: '🥣', label: 'Vorrat leer', at: s.runsOut, order: null },
    ]
      .map((m) => ({ ...m, past: new Date(m.at).getTime() < now }))
      .sort((a, b) => a.at.localeCompare(b.at));
  });

  /** Füllbalken: Vorrat jetzt im Verhältnis zur letzten Lieferung bzw. Zählung (mind. 1 Packung). */
  fill = computed(() => {
    const s = this.supply();
    if (!s?.known) return 0;
    const ref = Math.max(...s.entries.map((e) => e.grams), this.packKg() * 1000);
    return Math.min(1, (s.level ?? 0) / ref);
  });

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    forkJoin([this.api.supply(), this.api.food()]).subscribe({
      next: ([supply, food]) => {
        this.supply.set(supply);
        if (!this.stockEdited) this.stockText.set(supply.known ? formatDecimal((supply.level ?? 0) / 1000) : '');
        this.food.set(food);
        this.error.set(supply.error ? 'Cloud gerade nicht erreichbar, rechne mit dem letzten Stand 🙀' : null);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Backend nicht erreichbar 🙀');
        this.loading.set(false);
      },
    });
  }

  stepPacks(delta: number): void {
    this.packs.update((n) => Math.min(MAX_PACKS, Math.max(1, n + delta)));
  }

  setStock(kg: number): void {
    this.editStock(formatDecimal(kg));
  }

  editStock(text: string): void {
    this.stockEdited = true;
    this.stockText.set(text);
  }

  saveOrder(event: MouseEvent): void {
    if (this.saving() || !this.orderDate() || this.orderDate() > this.today) return;
    this.save({ kind: 'order', kg: this.orderKg(), date: this.orderDate() }, event, ORDER_LINES, ['📦', '🐟', '💕']);
  }

  saveStock(event: MouseEvent): void {
    const kg = this.stockKg();
    if (this.saving() || kg === null || kg < 0 || kg > 100) return;
    // 0 kg ist erlaubt („alles leer“), das Backend will aber > 0 → 1 g
    this.save({ kind: 'stock', kg: Math.max(kg, 0.001) }, event, STOCK_LINES, ['🧮', '🐾', '✨']);
  }

  arrived(id: number, event: MouseEvent): void {
    if (this.saving()) return;
    this.saving.set(true);
    this.api.confirmArrival(id).subscribe({
      next: () => {
        this.saving.set(false);
        this.stockEdited = false; // Vorrat im Feld gleich mit der Lieferung neu eintragen
        this.ui.showToast(pick(ARRIVED_LINES));
        this.ui.burst(event, ['📦', '🐟', '😻']);
        this.load();
      },
      error: (e) => {
        this.saving.set(false);
        this.ui.showToast(`Hoppla, das ging nicht 🙀 (${e.error?.detail ?? e.status})`);
      },
    });
  }

  remove(entry: SupplyEntry): void {
    if (this.armedDelete() !== entry.id) {
      this.armedDelete.set(entry.id);
      setTimeout(() => this.armedDelete.update((id) => (id === entry.id ? null : id)), 4000);
      return;
    }
    this.armedDelete.set(null);
    this.api.deleteSupply(entry.id).subscribe({
      next: () => {
        this.ui.showToast('Eintrag gelöscht 🗑️');
        this.load();
      },
      error: (e) => this.ui.showToast(`Hoppla, löschen ging nicht 🙀 (${e.error?.detail ?? e.status})`),
    });
  }

  kg(grams: number): string {
    return (grams / 1000).toLocaleString('de-CH', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  }

  private save(entry: { kind: 'order' | 'stock'; kg: number; date?: string }, event: MouseEvent, lines: string[], chars: string[]): void {
    this.saving.set(true);
    this.api.addSupply(entry).subscribe({
      next: () => {
        this.saving.set(false);
        this.stockEdited = false; // load() trägt gleich den neuen Vorrat ein
        this.ui.showToast(pick(lines));
        this.ui.burst(event, chars);
        this.load();
      },
      error: (e) => {
        this.saving.set(false);
        const detail = e.error?.detail;
        this.ui.showToast(`Hoppla, speichern ging nicht 🙀 (${typeof detail === 'string' ? detail : e.status})`);
      },
    });
  }
}
