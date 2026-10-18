// Gemeinsame Helfer für die SVG-Diagramme (Schnauz-Analyse, Futterkosten)

export const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDate = (s: string) => new Date(`${s}T12:00:00`);

/** Schöne Schrittweite für die y-Achse (10/20/25/50/100 …). */
export function niceStep(max: number): number {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((f) => f * mag >= raw) ?? 10) * mag;
}
