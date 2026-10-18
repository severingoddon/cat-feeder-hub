import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { forkJoin } from 'rxjs';
import { FeederService, Food, Supply, SupplyEntry } from '../feeder.service';
import { SupplyAlertComponent } from '../supply/supply-alert.component';
import { UiService, formatDecimal, parseDecimal, pick } from '../ui.service';
import { isoDate } from './chart';

const ORDER_LINES = ['Bestellung notiert! Die Chefs reiben sich die Pfoten 😻', 'Nachschub ist unterwegs 📦', 'Eingetragen. Das Buffet bleibt offen 🐟'];
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
  stockText = signal(''); // so wie getippt, Komma oder Punkt
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
      ...(s.pending ?? []).map((p) => ({ icon: '📦', label: `Lieferung kommt (${(p.grams / 1000).toLocaleString('de-CH')} kg)`, at: p.arrives })),
      { icon: '🛒', label: 'Erinnerung zum Bestellen', at: s.orderBy! },
      { icon: '⏰', label: `spätestens bestellen (${s.deliveryDays} Tage Lieferfrist)`, at: s.lastChance! },
      { icon: '🥣', label: 'Vorrat leer', at: s.runsOut },
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
    this.stockText.set(formatDecimal(kg));
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
    return (grams / 1000).toLocaleString('de-CH', { maximumFractionDigits: 2 });
  }

  private save(entry: { kind: 'order' | 'stock'; kg: number; date?: string }, event: MouseEvent, lines: string[], chars: string[]): void {
    this.saving.set(true);
    this.api.addSupply(entry).subscribe({
      next: () => {
        this.saving.set(false);
        this.stockText.set('');
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
