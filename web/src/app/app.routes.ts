import { Routes } from '@angular/router';
import { MenuPage } from './pages/menu.page';
import { AnalysisPage } from './pages/analysis.page';
import { PlanPage } from './pages/plan.page';

export const routes: Routes = [
  { path: '', component: MenuPage, title: 'Schnauz-Buffet' },
  { path: 'plan', component: PlanPage, title: 'Futterplan · Schnauz-Buffet' },
  { path: 'analyse', component: AnalysisPage, title: 'Schnauz-Analyse · Schnauz-Buffet' },
  { path: '**', redirectTo: '' },
];
