import { Routes } from '@angular/router';
import { MenuPage } from './pages/menu.page';
import { AnalysisPage } from './pages/analysis.page';
import { CostsPage } from './pages/costs.page';
import { OrdersPage } from './pages/orders.page';
import { PlanPage } from './pages/plan.page';

export const routes: Routes = [
  { path: '', component: MenuPage, title: 'Schnauz-Buffet' },
  { path: 'plan', component: PlanPage, title: 'Futterplan · Schnauz-Buffet' },
  { path: 'analyse', component: AnalysisPage, title: 'Schnauz-Analyse · Schnauz-Buffet' },
  { path: 'kosten', component: CostsPage, title: 'Futterkosten · Schnauz-Buffet' },
  { path: 'bestellungen', component: OrdersPage, title: 'Futterbestellungen · Schnauz-Buffet' },
  { path: '**', redirectTo: '' },
];
