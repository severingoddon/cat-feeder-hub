import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Supply } from '../feeder.service';

const day = (iso: string) => new Date(iso).toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'numeric' });

/** Roter Hinweis „Futter bestellen“ – auf der Hauptseite und bei den Bestellungen. Unsichtbar, solange alles reicht. */
@Component({
  selector: 'app-supply-alert',
  imports: [RouterLink],
  template: `
    @if (message(); as m) {
      <div class="supply-alert" [class.urgent]="m.urgent" role="alert">
        <span class="ico" aria-hidden="true">{{ m.icon }}</span>
        <p>
          <strong>{{ m.title }}</strong>
          {{ m.text }}
          @if (link()) { <a routerLink="/bestellungen">Bestellung erfassen →</a> }
        </p>
      </div>
    }
  `,
  styles: `
    .supply-alert {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      background: var(--danger-bg);
      color: var(--danger);
      border: 2px solid var(--danger);
      border-radius: var(--radius);
      padding: 10px 14px;
      margin-bottom: 12px;
      font-size: 0.85rem;
      line-height: 1.35;

      &.urgent { animation: nudge 1.6s ease-in-out infinite; }
    }
    .ico { font-size: 1.4rem; line-height: 1; }
    p { margin: 0; }
    strong { display: block; font-size: 0.95rem; }
    a { color: var(--danger); font-weight: 600; white-space: nowrap; }
    @keyframes nudge {
      0%, 100% { box-shadow: 0 0 0 0 transparent; }
      50% { box-shadow: 0 0 0 5px var(--danger-bg); }
    }
  `,
})
export class SupplyAlertComponent {
  supply = input<Supply | null>(null);
  link = input(true); // auf der Bestellseite selbst ohne Link

  message = computed(() => {
    const s = this.supply();
    if (!s?.known || !s.runsOut) return null;
    if (s.gap) {
      return {
        icon: '⚠️', urgent: true, title: 'Futter wird knapp!',
        text: `Leer ab ca. ${day(s.gap.from)}, die Lieferung kommt erst ${day(s.gap.until)}.`,
      };
    }
    if (s.urgent) {
      return {
        icon: '🚨', urgent: true, title: 'Jetzt Futter bestellen!',
        text: `Vorrat reicht nur noch bis ca. ${day(s.runsOut)}, die Lieferung dauert ${s.deliveryDays} Tage.`,
      };
    }
    if (s.reminder) {
      return {
        icon: '🛒', urgent: false, title: 'Zeit, Futter zu bestellen',
        text: `Vorrat reicht noch ca. ${Math.floor(s.daysLeft ?? 0)} Tage (bis ${day(s.runsOut)}).`,
      };
    }
    return null;
  });
}
