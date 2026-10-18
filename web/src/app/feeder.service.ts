import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

/** Jeder Automat hat zwei Näpfe, pro Portion fallen in jeden Napf genau 7 g. */
export const GRAMS_PER_BOWL = 7;
export const BOWLS_PER_FEEDER = 2;
export const GRAMS_PER_PORTION = GRAMS_PER_BOWL * BOWLS_PER_FEEDER;
export const CATS = 3;

export interface Meal {
  id: string; // "HH:MM"
  hour: number;
  minute: number;
  portions: number;
  enabled: boolean;
  days: number;
  skippedFor: string | null;
  next: string;
}

/** Neue Mahlzeiten gelten immer täglich – Wochentage werden nicht bearbeitet. */
export interface MealInput {
  hour: number;
  minute: number;
  portions: number;
}

export interface Feeder {
  key: string;
  name: string;
  meals: Meal[];
  error: string | null;
}

export interface FeedersResponse {
  now: string;
  feeders: Feeder[];
}

export interface DayCount {
  portions: number; // tatsächlich ausgegeben (laut feed_report)
  extra: number; // davon ausserhalb des Plans, also von Hand
  skipped: number; // ausgesetzt („Für heute aussetzen“)
}

export interface FeedEvent {
  feeder: string;
  ts: string;
  portions: number;
  extra: boolean;
}

export interface SkipEvent {
  feeder: string;
  ts: string;
  portions: number;
}

/** Alles in Portionen – Gramm rechnet das Frontend mit GRAMS_PER_PORTION. */
export interface AnalysisResponse {
  now: string;
  feeders: { key: string; name: string; planPortions: number }[];
  days: { date: string; feeders: Record<string, DayCount> }[];
  events: FeedEvent[];
  skips: SkipEvent[];
  since: string | null; // ältester Eintrag im Verlauf
  syncedAt: string | null;
  error: string | null;
}

/** Futter für die Kostenanalyse, im Backend gespeichert. */
export interface Food {
  name: string;
  pricePerKg: number; // CHF
  packKg: number; // Inhalt einer Packung (1.4 kg)
}

export interface SupplyEntry {
  id: number;
  kind: 'order' | 'stock'; // Bestellung oder von Hand gezählter Vorrat
  ts: string;
  grams: number;
  arrives: string; // Bestellung: ts + Lieferfrist
}

/** Vorrat und Hochrechnung vom Backend. known = false, solange noch nichts erfasst ist. */
export interface Supply {
  known: boolean;
  entries: SupplyEntry[];
  deliveryDays: number;
  reminderDays: number;
  rate: number; // erwarteter Verbrauch in g/Tag
  rateBasis: 'plan' | 'average';
  level?: number; // g jetzt
  pending?: { grams: number; arrives: string }[];
  runsOut?: string | null;
  daysLeft?: number | null;
  orderBy?: string | null; // ab hier erinnern
  lastChance?: string | null; // spätestens bestellen (Lieferfrist)
  reminder?: boolean;
  urgent?: boolean;
  gap?: { from: string; until: string } | null; // leer, bevor die nächste Lieferung da ist
  error: string | null;
}

@Injectable({ providedIn: 'root' })
export class FeederService {
  private http = inject(HttpClient);

  load(refresh = false): Observable<FeedersResponse> {
    return this.http.get<FeedersResponse>('/api/feeders', { params: refresh ? { refresh: 'true' } : {} });
  }

  analysis(days: number): Observable<AnalysisResponse> {
    return this.http.get<AnalysisResponse>('/api/analysis', { params: { days } });
  }

  food(): Observable<Food> {
    return this.http.get<Food>('/api/food');
  }

  saveFood(food: Food): Observable<Food> {
    return this.http.put<Food>('/api/food', food);
  }

  supply(): Observable<Supply> {
    return this.http.get<Supply>('/api/supply');
  }

  addSupply(entry: { kind: 'order' | 'stock'; kg: number; date?: string }): Observable<{ id: number }> {
    return this.http.post<{ id: number }>('/api/supply', entry);
  }

  deleteSupply(id: number): Observable<unknown> {
    return this.http.delete(`/api/supply/${id}`);
  }

  skip(feeder: string, meal: string): Observable<{ skippedFor: string }> {
    return this.http.post<{ skippedFor: string }>(`/api/feeders/${feeder}/meals/${meal}/skip`, {});
  }

  feed(feeder: string): Observable<unknown> {
    return this.http.post(`/api/feeders/${feeder}/feed`, {});
  }

  unskip(feeder: string, meal: string): Observable<unknown> {
    return this.http.delete(`/api/feeders/${feeder}/meals/${meal}/skip`);
  }

  addMeal(feeder: string, meal: MealInput): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`/api/feeders/${feeder}/meals`, meal);
  }

  editMeal(feeder: string, meal: string, changes: MealInput): Observable<{ id: string }> {
    return this.http.put<{ id: string }>(`/api/feeders/${feeder}/meals/${meal}`, changes);
  }

  deleteMeal(feeder: string, meal: string): Observable<unknown> {
    return this.http.delete(`/api/feeders/${feeder}/meals/${meal}`);
  }
}
