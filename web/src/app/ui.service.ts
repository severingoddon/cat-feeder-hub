import { Injectable, signal } from '@angular/core';

export interface Heart {
  id: number;
  x: number;
  delay: number;
  char: string;
}

const CAT_COUNT = 15;
const AVATARS: Partial<Record<string, number>> = { links: 6, rechts: 4 };

export function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/** Toast, Herzchen und Foto-Zoom – werden von der App-Hülle angezeigt und von allen Seiten genutzt. */
@Injectable({ providedIn: 'root' })
export class UiService {
  readonly cats = Array.from({ length: CAT_COUNT }, (_, i) => `cats/${i + 1}.jpg`);

  toast = signal<{ text: string; cat: string } | null>(null);
  hearts = signal<Heart[]>([]);
  zoomed = signal<string | null>(null);

  private heartId = 0;
  private toastTimer?: ReturnType<typeof setTimeout>;

  avatar(key: string): string {
    return `cats/${AVATARS[key] ?? 1}.jpg`;
  }

  showToast(text: string): void {
    clearTimeout(this.toastTimer);
    this.toast.set({ text, cat: pick(this.cats) });
    this.toastTimer = setTimeout(() => this.toast.set(null), 3500);
  }

  burst(event: MouseEvent, chars: string[]): void {
    const x = (event.clientX / window.innerWidth) * 100;
    const fresh = Array.from({ length: 12 }, () => ({
      id: this.heartId++,
      x: x + (Math.random() - 0.5) * 30,
      delay: Math.random() * 0.4,
      char: pick(chars),
    }));
    this.hearts.update((h) => [...h, ...fresh]);
    setTimeout(() => this.hearts.update((h) => h.filter((x) => !fresh.includes(x))), 2200);
  }
}
