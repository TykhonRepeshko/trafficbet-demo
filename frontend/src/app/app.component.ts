import { AsyncPipe, DecimalPipe, NgIf } from '@angular/common';
import { Component, ElementRef, HostListener, OnDestroy, OnInit, inject } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { environment } from '../environments/environment';
import { AuthService } from './services/auth.service';
import { ApiService } from './services/api.service';
import { Subscription, filter, timeout } from 'rxjs';
import { apiError } from './services/ui-helpers';
import { ThemeService } from './services/theme.service';
import { IconComponent } from './components/icon.component';

@Component({
  selector: 'app-root', standalone: true,
  imports: [AsyncPipe, DecimalPipe, NgIf, RouterLink, RouterLinkActive, RouterOutlet, IconComponent],
  template: `
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <div class="tb-app" [class.is-play]="isPlay">
      <header class="tb-header">
        <div class="tb-header-inner">
          <a routerLink="/" class="tb-brand" aria-label="TrafficBet home">
            <span class="tb-brand-mark" aria-hidden="true"><svg viewBox="0 0 64 64" focusable="false"><path d="m16 53 8-42m24 42-8-42M32 12v7m0 7v7m0 7v11" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><rect x="21" y="31" width="8" height="15" rx="2.5" fill="currentColor"/><rect x="35" y="18" width="8" height="15" rx="2.5" fill="currentColor"/></svg></span>
            <span class="tb-brand-text">traffic<b>bet</b></span>
          </a>
          <nav class="tb-nav" aria-label="Main navigation">
            <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }" ariaCurrentWhenActive="page"><app-icon name="play"></app-icon>Play</a>
            <a *ngIf="auth.isAdmin" routerLink="/streams" routerLinkActive="active" ariaCurrentWhenActive="page"><app-icon name="camera"></app-icon>Cameras</a>
            <a routerLink="/bets" routerLinkActive="active" ariaCurrentWhenActive="page"><app-icon name="ticket"></app-icon>My predictions</a>
            <a routerLink="/how-it-works" routerLinkActive="active" ariaCurrentWhenActive="page"><app-icon name="help"></app-icon>How it works</a>
            <a *ngIf="auth.isAdmin" routerLink="/admin" routerLinkActive="active" ariaCurrentWhenActive="page"><app-icon name="settings"></app-icon>Admin</a>
          </nav>
          <div class="tb-header-actions">
            <button type="button" class="tb-icon-btn tb-theme-btn" role="switch" aria-label="Dark theme" [attr.aria-checked]="theme.isDark()" [attr.title]="theme.isDark() ? 'Switch to light theme' : 'Switch to dark theme'" (click)="theme.toggle()"><app-icon [name]="theme.isDark() ? 'sun' : 'moon'"></app-icon></button>
            <ng-container *ngIf="auth.user$ | async as user; else guest">
              <a routerLink="/account" class="tb-balance" [attr.aria-label]="'Virtual balance: ' + (user.balanceCredits | number:'1.0-0') + ' credits'" title="Virtual balance"><app-icon name="coins" [size]="17"></app-icon>{{ user.balanceCredits | number:'1.0-0' }} <small>cr</small></a>
              <div class="tb-user">
                <button type="button" class="tb-avatar" (click)="toggleMenu($event)" [attr.aria-expanded]="menuOpen" aria-haspopup="menu" [attr.aria-label]="'Account menu for ' + user.displayName">{{ user.displayName.slice(0, 1) }}</button>
                <div class="tb-menu" role="menu" *ngIf="menuOpen">
                  <div class="tb-menu-head"><strong>{{ user.displayName }}</strong><small>{{ user.role === 'admin' ? 'Administrator' : 'Member' }} · {{ user.balanceCredits | number:'1.0-0' }} cr</small></div>
                  <a role="menuitem" routerLink="/account"><app-icon name="user"></app-icon>My account</a>
                  <a role="menuitem" routerLink="/bets"><app-icon name="ticket"></app-icon>My predictions</a>
                  <a role="menuitem" *ngIf="auth.isAdmin" routerLink="/admin"><app-icon name="settings"></app-icon>Admin panel</a>
                  <hr>
                  <button role="menuitem" type="button" (click)="logout()" [disabled]="leaving"><app-icon name="logout"></app-icon>{{ leaving ? 'Signing out…' : 'Sign out' }}</button>
                </div>
              </div>
            </ng-container>
            <ng-template #guest><div class="tb-guest"><a *ngIf="!preview" routerLink="/register" class="tb-btn tb-btn-ghost tb-btn-sm">Create account</a><a routerLink="/login" class="tb-btn tb-btn-primary tb-btn-sm">Sign in</a></div></ng-template>
          </div>
        </div>
      </header>
      <div *ngIf="preview" class="tb-banner" role="status"><div><strong>Design preview</strong><span>Sample data resets when you refresh this page.</span></div></div>
      <div *ngIf="!preview && connection === 'offline'" class="tb-banner is-error" role="alert"><div><app-icon name="alert"></app-icon><span>We can’t reach the service right now.</span><button type="button" (click)="checkConnection()">Try again</button></div></div>
      <div *ngIf="sessionError" class="tb-banner is-error" role="alert"><div>{{ sessionError }}</div></div>
      <div *ngIf="auth.sessionExpired" class="tb-banner" role="alert"><div>Your session has expired. <a routerLink="/login" [queryParams]="{ returnUrl: currentUrl }">Sign in again</a></div></div>
      <main id="main-content" class="tb-main" tabindex="-1"><router-outlet></router-outlet></main>
      <footer class="tb-footer" *ngIf="!isPlay"><div class="tb-footer-inner"><span>TrafficBet · virtual credits only, no real money</span><nav aria-label="Footer"><a routerLink="/how-it-works">Rules</a><a *ngIf="auth.isAdmin" routerLink="/admin">Admin</a></nav></div></footer>
      <nav class="tb-tabbar" aria-label="Quick navigation">
        <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }" ariaCurrentWhenActive="page"><app-icon name="play" [size]="22"></app-icon>Play</a>
        <a *ngIf="auth.isAdmin" routerLink="/streams" routerLinkActive="active" ariaCurrentWhenActive="page"><app-icon name="camera" [size]="22"></app-icon>Cameras</a>
        <a routerLink="/bets" routerLinkActive="active" ariaCurrentWhenActive="page"><app-icon name="ticket" [size]="22"></app-icon>Predictions</a>
        <a routerLink="/how-it-works" routerLinkActive="active" ariaCurrentWhenActive="page"><app-icon name="help" [size]="22"></app-icon>Rules</a>
        <a *ngIf="auth.user; else signInTab" routerLink="/account" routerLinkActive="active" ariaCurrentWhenActive="page"><app-icon name="user" [size]="22"></app-icon>Account</a>
        <ng-template #signInTab><a routerLink="/login" routerLinkActive="active"><app-icon name="user" [size]="22"></app-icon>Sign in</a></ng-template>
      </nav>
    </div>
  `
})
export class AppComponent implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  readonly theme = inject(ThemeService);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly preview = environment.preview;
  leaving = false;
  sessionError = '';
  menuOpen = false;
  connection: 'checking' | 'online' | 'offline' = 'checking';
  readonly connectionTitle = 'Service connection status';
  private healthTimer?: number;
  private checking = false;
  private navigation?: Subscription;
  get currentUrl(): string { return this.router.url; }
  /** The play screen fills exactly one viewport (no footer, no page scroll). */
  get isPlay(): boolean { const path = (this.router.url ?? '/').split(/[?#]/)[0]; return path === '/' || path === ''; }
  ngOnInit(): void {
    if (!this.preview) { this.checkConnection(); this.healthTimer = window.setInterval(() => this.checkConnection(), 30_000); }
    this.navigation = this.router.events?.pipe(filter((event) => event instanceof NavigationEnd)).subscribe(() => { this.menuOpen = false; });
  }
  ngOnDestroy(): void { if (this.healthTimer) window.clearInterval(this.healthTimer); this.navigation?.unsubscribe(); }
  toggleMenu(event: Event): void { event.stopPropagation(); this.menuOpen = !this.menuOpen; }
  @HostListener('document:click', ['$event']) closeMenuOutside(event: Event): void {
    if (!this.menuOpen) return;
    const menu = (this.host.nativeElement as HTMLElement).querySelector('.tb-user');
    if (!menu?.contains(event.target as Node)) this.menuOpen = false;
  }
  @HostListener('document:keydown.escape') closeMenu(): void { this.menuOpen = false; }
  checkConnection(): void { if (this.checking || this.preview) return; this.checking = true; this.api.health().pipe(timeout(5000)).subscribe({ next: ({ ok }) => { this.connection = ok ? 'online' : 'offline'; this.checking = false; }, error: () => { this.connection = 'offline'; this.checking = false; } }); }
  logout(): void {
    this.leaving = true; this.sessionError = '';
    this.auth.logout().subscribe({ next: () => { this.leaving = false; this.menuOpen = false; void this.router.navigateByUrl('/'); }, error: (error) => { this.leaving = false; this.sessionError = apiError(error); } });
  }
}
