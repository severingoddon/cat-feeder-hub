import { Component, DestroyRef, HostListener, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { UiService } from './ui.service';

// ng build hängt einen Hash an den Namen – ändert er sich, wurde neu deployt
const BUNDLE = /main-[A-Z0-9]+\.js/;

/** Hülle um alle Seiten: Burger-Menü, Toast, Herzchen und Foto-Zoom. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  readonly ui = inject(UiService);
  menuOpen = signal(false);

  constructor() {
    // Die Homescreen-App auf dem iPhone bleibt im Hintergrund offen und lädt beim Zurückkommen nicht neu.
    // Darum beim Sichtbarwerden nachschauen, ob auf dem Server eine neuere Version liegt.
    const onVisible = () => document.visibilityState === 'visible' && this.checkForUpdate();
    document.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('visibilitychange', onVisible));
  }

  private async checkForUpdate(): Promise<void> {
    const current = document.querySelector<HTMLScriptElement>('script[src*="main-"]')?.src.match(BUNDLE)?.[0];
    if (!current) return; // ng serve: kein Hash
    try {
      const html = await (await fetch('/', { cache: 'no-store' })).text();
      const latest = html.match(BUNDLE)?.[0];
      if (latest && latest !== current) location.reload();
    } catch {
      // offline – dann eben beim nächsten Mal
    }
  }

  @HostListener('document:keydown.escape')
  closeMenu(): void {
    this.menuOpen.set(false);
  }
}
