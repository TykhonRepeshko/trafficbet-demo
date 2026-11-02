import { NgIf } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { environment } from '../../environments/environment';
import { AuthService } from '../services/auth.service';
import { IconComponent } from '../components/icon.component';
import { apiError } from '../services/ui-helpers';

@Component({ selector: 'app-login', standalone: true, imports: [FormsModule, NgIf, RouterLink, IconComponent], template: `
  <section class="auth">
    <div class="tb-card auth-card">
      <a routerLink="/" class="auth-brand" aria-label="TrafficBet home"><span class="tb-brand-mark" aria-hidden="true"><svg viewBox="0 0 64 64" focusable="false"><path d="m16 53 8-42m24 42-8-42M32 12v7m0 7v7m0 7v11" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><rect x="21" y="31" width="8" height="15" rx="2.5" fill="currentColor"/><rect x="35" y="18" width="8" height="15" rx="2.5" fill="currentColor"/></svg></span><span>traffic<b>bet</b></span></a>
      <h1>{{ preview ? 'Try both roles' : adminRequired ? 'Administrator sign-in' : 'Welcome back' }}</h1>
      <p class="auth-sub">{{ preview ? 'Choose a sample profile. Changes are stored only in this tab.' : adminRequired ? 'Manage cameras, rounds and result verification.' : 'Sign in to make predictions and follow your results.' }}</p>
      <div class="tb-alert is-warn" *ngIf="adminRequired"><app-icon name="shield"></app-icon><div><p><strong>Administrator access required.</strong></p><p *ngIf="auth.user && !auth.isAdmin">Your current account doesn’t have administrator access.</p><p>Ask the deployment owner for access. New registrations create member accounts.</p></div></div>
      <div *ngIf="preview" class="auth-demo"><button class="auth-demo-role" type="button" (click)="demo('user')" [disabled]="loading"><app-icon name="user" [size]="20"></app-icon><span><strong>Member view</strong><small>Predictions, balance and history</small></span><app-icon name="arrow" [size]="16"></app-icon></button><button class="auth-demo-role" type="button" (click)="demo('admin')" [disabled]="loading"><app-icon name="settings" [size]="20"></app-icon><span><strong>Administrator view</strong><small>Cameras, rounds and verification</small></span><app-icon name="arrow" [size]="16"></app-icon></button></div>
      <form *ngIf="!preview" class="auth-form" (ngSubmit)="form.valid && submit()" #form="ngForm">
        <label class="tb-field">Email<input class="tb-input" name="email" type="email" autocomplete="username" [(ngModel)]="email" placeholder="you@example.com" maxlength="254" required email></label>
        <label class="tb-field">Password<input class="tb-input" name="password" type="password" autocomplete="current-password" [(ngModel)]="password" placeholder="Your password" maxlength="256" required></label>
        <p class="tb-alert is-error" *ngIf="error" role="alert">{{ error }}</p>
        <button class="tb-btn tb-btn-primary tb-btn-lg tb-btn-block" type="submit" [disabled]="loading || form.invalid"><span class="tb-spinner" *ngIf="loading"></span>{{ loading ? 'Signing in…' : 'Sign in' }}</button>
      </form>
      <p class="tb-alert is-error" *ngIf="error && preview" role="alert">{{ error }}</p>
      <p *ngIf="!preview && !adminRequired" class="auth-switch">New here? <a routerLink="/register" [queryParams]="returnParams">Create a free account</a></p>
      <p class="auth-note">{{ preview ? 'Refreshing the page resets this sample session.' : 'You stay signed in until you sign out or your session expires.' }}</p>
    </div>
    <a routerLink="/" class="auth-back"><app-icon name="back" [size]="16"></app-icon>Back to cameras</a>
  </section>
` })
export class LoginComponent {
  readonly auth = inject(AuthService); private readonly router = inject(Router); private readonly route = inject(ActivatedRoute);
  readonly preview = environment.preview;
  get adminRequired(): boolean { return this.route.snapshot.queryParamMap.has('admin') || this.route.snapshot.queryParamMap.get('returnUrl') === '/admin'; }
  get returnParams(): { returnUrl: string | null } { return { returnUrl: this.route.snapshot.queryParamMap.get('returnUrl') }; }
  email = ''; password = ''; loading = false; error = '';
  demo(role: 'user' | 'admin'): void { if (!this.preview) return; this.email = role + '@demo.local'; this.password = ''; this.submit(); }
  submit(): void { if (this.loading) return; if (!this.preview && new TextEncoder().encode(this.password).length > 72) { this.error = 'Your password must not exceed 72 UTF-8 bytes.'; return; } this.loading = true; this.error = ''; this.auth.login(this.email.trim(), this.password).subscribe({ next: () => { this.loading = false; this.password = ''; const requested = this.route.snapshot.queryParamMap.get('returnUrl'); const target = requested && /^\/(bets|admin(?:\/preparation|\/media-lab)?|account|streams\/\d+)$/.test(requested) ? requested : '/'; if (target.startsWith('/admin') && !this.auth.isAdmin) { this.error = 'An administrator account is required to open the admin panel.'; return; } void this.router.navigateByUrl(target); }, error: (error) => { this.loading = false; this.password = ''; this.error = error?.status === 401 ? 'The email address or password is incorrect.' : apiError(error); } }); }
}
