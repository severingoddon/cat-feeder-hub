import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

/** Jeder Automat hat zwei Näpfe, pro Portion fallen in jeden Napf genau 7 g. */
export const GRAMS_PER_BOWL = 7;
export const BOWLS_PER_FEEDER = 2;
export const GRAMS_PER_PORTION = GRAMS_PER_BOWL * BOWLS_PER_FEEDER;

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

@Injectable({ providedIn: 'root' })
export class FeederService {
  private http = inject(HttpClient);

  load(refresh = false): Observable<FeedersResponse> {
    return this.http.get<FeedersResponse>('/api/feeders', { params: refresh ? { refresh: 'true' } : {} });
  }

  analysis(days: number): Observable<AnalysisResponse> {
    return this.http.get<AnalysisResponse>('/api/analysis', { params: { days } });
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
