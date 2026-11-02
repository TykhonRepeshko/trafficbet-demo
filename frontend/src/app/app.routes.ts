import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { AuthService } from './services/auth.service';

const signedIn: CanActivateFn = (_, state) => {
  const auth = inject(AuthService); const router = inject(Router);
  return auth.user ? true : router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};
const administrator: CanActivateFn = () => {
  const auth = inject(AuthService); const router = inject(Router);
  return auth.isAdmin ? true : router.createUrlTree(['/login'], { queryParams: { returnUrl: '/admin', admin: 'required' } });
};
export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/play.component').then((module) => module.PlayComponent), title: 'Play · TrafficBet' },
  { path: 'how-it-works', loadComponent: () => import('./pages/how-it-works.component').then((module) => module.HowItWorksComponent), title: 'How it works · TrafficBet' },
  { path: 'streams/:id', loadComponent: () => import('./pages/stream-detail.component').then((module) => module.StreamDetailComponent), title: 'Camera · TrafficBet' },
  { path: 'bets', loadComponent: () => import('./pages/bets.component').then((module) => module.BetsComponent), canActivate: [signedIn], title: 'My predictions · TrafficBet' },
  { path: 'account', loadComponent: () => import('./pages/account.component').then((module) => module.AccountComponent), canActivate: [signedIn], title: 'My account · TrafficBet' },
  { path: 'admin', loadComponent: () => import('./pages/admin.component').then((module) => module.AdminComponent), canActivate: [signedIn, administrator], title: 'Admin panel · TrafficBet' },
  { path: 'admin/media-lab', loadComponent: () => import('./pages/streaming-lab.component').then((module) => module.StreamingLabComponent), canActivate: [signedIn, administrator], title: 'Streaming lab · TrafficBet' },
  { path: 'admin/preparation', loadComponent: () => import('./pages/preparation.component').then((module) => module.PreparationComponent), canActivate: [signedIn, administrator], title: 'Counting preparation · TrafficBet' },
  { path: 'login', loadComponent: () => import('./pages/login.component').then((module) => module.LoginComponent), title: 'Sign in · TrafficBet' },
  { path: 'register', loadComponent: () => import('./pages/register.component').then((module) => module.RegisterComponent), title: 'Create account · TrafficBet' },
  { path: '**', redirectTo: '' }
];
