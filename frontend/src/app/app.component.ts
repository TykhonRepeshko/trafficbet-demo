import { AsyncPipe, DecimalPipe, NgIf } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { environment } from '../environments/environment';
import { AuthService } from './services/auth.service';
import { ApiService } from './services/api.service';
import { timeout } from 'rxjs';
import { apiError } from './services/ui-helpers';
import { ThemeService } from './services/theme.service';

@Component({
  selector: 'app-root', standalone: true,
  imports: [AsyncPipe, DecimalPipe, NgIf, RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <div class="app-shell">
      <aside class="sidebar">
        <a routerLink="/" class="brand" aria-label="TrafficBet overview"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 64 64" focusable="false"><path d="m16 53 8-42m24 42-8-42M32 12v7m0 7v7m0 7v11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><rect x="21" y="31" width="8" height="15" rx="2.5" fill="currentColor"/><rect x="35" y="18" width="8" height="15" rx="2.5" fill="currentColor"/><path d="M23 35h4m10-13h4" stroke="#f36e43" stroke-width="2" stroke-linecap="round"/></svg></span><span>traffic<span class="brand-light">bet</span><small>THE CITY IN MOTION</small></span></a>
        <div class="workspace-label">EXPLORE</div>
        <nav class="side-nav" aria-label="Main navigation">
          <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }"><span class="nav-icon">▦</span> Live cameras <span class="nav-arrow">↗</span></a>
          <a routerLink="/how-it-works" routerLinkActive="active" ariaCurrentWhenActive="page" title="How it works · Rules"><span class="nav-icon" aria-hidden="true">ⓘ</span> How it works</a>
          <a routerLink="/bets" routerLinkActive="active"><span class="nav-icon">◷</span> My predictions</a>
          <a *ngIf="auth.user" routerLink="/account" routerLinkActive="active"><span class="nav-icon">◉</span> My account</a>
          <a *ngIf="auth.isAdmin" routerLink="/admin" routerLinkActive="active" aria-label="Admin panel"><span class="nav-icon" aria-hidden="true">⚙</span> Admin panel</a>
        </nav>
        <div class="sidebar-bottom"><div class="ai-symbol" aria-hidden="true">◷</div><strong>Watch. Count. Verify.</strong><p>Predictions close before counting. A result requires complete coverage and the same counting zone.</p><span class="dark-pill">Manual verification</span></div>
        <div class="sidebar-foot">Watch <span>·</span> Predict <span>·</span> Verify</div>
      </aside>
      <div class="workspace">
        <header class="topbar">
          <div class="workspace-name" [attr.title]="preview ? 'Standalone design preview' : connectionTitle"><span class="dot" [class.orange]="preview || connection !== 'online'"></span> {{ preview ? 'Design preview' : connection === 'online' ? 'Connected' : connection === 'offline' ? 'Connection unavailable' : 'Connecting' }} <span class="version">/ v0.3</span></div>
          <div class="topbar-actions">
          <button type="button" class="theme-toggle" role="switch" aria-label="Dark theme" [attr.aria-checked]="theme.isDark()" [attr.title]="theme.isDark() ? 'Switch to light theme' : 'Switch to dark theme'" (click)="theme.toggle()"><svg *ngIf="!theme.isDark()" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg><svg *ngIf="theme.isDark()" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 15.4A8.5 8.5 0 0 1 8.6 4 8.5 8.5 0 1 0 20 15.4Z"/></svg><span>{{ theme.isDark() ? 'Dark' : 'Light' }}</span></button>
          <div class="session" *ngIf="auth.user$ | async as user; else guest"><a routerLink="/account" class="balance"><small>VIRTUAL BALANCE</small><strong>{{ user.balanceCredits | number:'1.0-0' }} <span>cr</span></strong></a><a routerLink="/account" class="avatar" aria-label="My account">{{ user.displayName.slice(0, 1) }}</a><a routerLink="/account" class="session-name"><strong>{{ user.displayName }}</strong><small>{{ user.role === 'admin' ? 'Administrator' : 'Member' }}</small></a><button class="icon-button" type="button" (click)="logout()" [disabled]="leaving" aria-label="Sign out of your account" title="Sign out">↪</button></div>
          <ng-template #guest><div class="guest-actions"><a *ngIf="!preview" routerLink="/register" class="button compact">Create account</a><a routerLink="/login" class="button primary compact">Sign in <span>↗</span></a></div></ng-template>
          </div>
        </header>
        <div *ngIf="preview" class="preview-banner" role="status"><strong>Design preview</strong><span>Temporary sample data resets when you refresh this page.</span><span class="preview-label">SIMULATION</span></div>
        <div *ngIf="!preview && connection === 'offline'" class="connection-banner" role="alert"><span>We could not connect to the service. Your data has not loaded.</span><button type="button" class="text-button" (click)="checkConnection()">Try again</button></div>
        <div *ngIf="sessionError" class="global-error" role="alert">{{ sessionError }}</div>
        <div *ngIf="auth.sessionExpired" class="global-error" role="alert">Your session has expired. <a routerLink="/login" [queryParams]="{ returnUrl: currentUrl }">Sign in again</a> to continue.</div>
        <main id="main-content"><router-outlet></router-outlet></main>
        <footer class="page-footer"><span>TrafficBet · traffic prediction lab <a routerLink="/how-it-works" class="footer-guide">How it works</a><a *ngIf="auth.isAdmin" routerLink="/admin" class="footer-admin">Admin panel ↗</a></span><span>Virtual credits only · no monetary transactions</span></footer>
      </div>
    </div>
  `
})
export class AppComponent implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  readonly theme = inject(ThemeService);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  readonly preview = environment.preview;
  leaving = false;
  sessionError = '';
  connection: 'checking' | 'online' | 'offline' = 'checking';
  readonly connectionTitle = 'Service connection status';
  private healthTimer?: number;
  private checking = false;
  get currentUrl(): string { return this.router.url; }
  ngOnInit(): void { if (!this.preview) { this.checkConnection(); this.healthTimer = window.setInterval(() => this.checkConnection(), 30_000); } }
  ngOnDestroy(): void { if (this.healthTimer) window.clearInterval(this.healthTimer); }
  checkConnection(): void { if (this.checking || this.preview) return; this.checking = true; this.api.health().pipe(timeout(5000)).subscribe({ next: ({ ok }) => { this.connection = ok ? 'online' : 'offline'; this.checking = false; }, error: () => { this.connection = 'offline'; this.checking = false; } }); }
  logout(): void {
    this.leaving = true; this.sessionError = '';
    this.auth.logout().subscribe({ next: () => { this.leaving = false; void this.router.navigateByUrl('/'); }, error: (error) => { this.leaving = false; this.sessionError = apiError(error); } });
  }
}
