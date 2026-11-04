import { NgIf } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { environment } from '../../environments/environment';
import { AuthService } from '../services/auth.service';
import { IconComponent } from '../components/icon.component';
import { apiError } from '../services/ui-helpers';

@Component({ selector: 'app-register', standalone: true, imports: [FormsModule, NgIf, RouterLink, IconComponent], template: `
  <section class="auth">
    <div class="tb-card auth-card">
      <a routerLink="/" class="auth-brand" aria-label="TrafficBet home"><span class="tb-brand-mark" aria-hidden="true"><svg viewBox="0 0 64 64" focusable="false"><path d="m16 53 8-42m24 42-8-42M32 12v7m0 7v7m0 7v11" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><rect x="21" y="31" width="8" height="15" rx="2.5" fill="currentColor"/><rect x="35" y="18" width="8" height="15" rx="2.5" fill="currentColor"/></svg></span><span>traffic<b>bet</b></span></a>
      <h1>Create your account</h1>
      <p class="auth-sub">Start with <strong>10,000 virtual credits</strong> and test your predictions on real traffic.</p>
      <p *ngIf="preview" class="tb-alert is-warn">This is a standalone design preview. Open the main application to create a persistent account.</p>
      <form *ngIf="!preview" class="auth-form" (ngSubmit)="form.valid && submit()" #form="ngForm">
        <label class="tb-field">Display name<input class="tb-input" name="displayName" autocomplete="nickname" [(ngModel)]="displayName" placeholder="What should we call you?" minlength="2" maxlength="80" required></label>
        <label class="tb-field">Email<input class="tb-input" name="email" type="email" autocomplete="username" [(ngModel)]="email" placeholder="you@example.com" maxlength="254" required email></label>
        <label class="tb-field">Password<input class="tb-input" name="password" type="password" autocomplete="new-password" [(ngModel)]="password" placeholder="At least 12 characters" minlength="12" maxlength="72" required aria-describedby="password-requirements"><small id="password-requirements">At least 12 characters. Use a password you don’t use elsewhere.</small></label>
        <label class="tb-field">Confirm password<input class="tb-input" name="confirmation" type="password" autocomplete="new-password" [(ngModel)]="confirmation" placeholder="Repeat your password" maxlength="72" required></label>
        <p class="tb-alert is-error" *ngIf="error" role="alert">{{ error }}</p>
        <button class="tb-btn tb-btn-primary tb-btn-lg tb-btn-block" type="submit" [disabled]="loading || form.invalid"><span class="tb-spinner" *ngIf="loading"></span>{{ loading ? 'Creating account…' : 'Create account' }}</button>
      </form>
      <p class="auth-switch">Already have an account? <a routerLink="/login" [queryParams]="returnParams">Sign in</a></p>
      <p class="auth-note">Virtual credits only — they can’t be bought, withdrawn or exchanged for money.</p>
    </div>
    <a routerLink="/" class="auth-back"><app-icon name="back" [size]="16"></app-icon>Back to Play</a>
  </section>
` })
export class RegisterComponent {
  private readonly auth = inject(AuthService); private readonly router = inject(Router); private readonly route = inject(ActivatedRoute);
  readonly preview = environment.preview;
  readonly returnParams = { returnUrl: this.route.snapshot.queryParamMap.get('returnUrl') };
  displayName = ''; email = ''; password = ''; confirmation = ''; loading = false; error = '';
  submit(): void {
    if (this.loading || this.preview) return;
    this.error = '';
    const displayName = this.displayName.trim(); const email = this.email.trim();
    const bytes = new TextEncoder().encode(this.password).length;
    if ([...displayName].length < 2 || [...displayName].length > 80 || /[\u0000-\u001f\u007f]/.test(displayName)) { this.error = 'Your display name must contain 2 to 80 characters, without control characters.'; return; }
    if (new TextEncoder().encode(email).length > 254) { this.error = 'The email address is too long.'; return; }
    if ([...this.password].length < 12 || bytes > 72) { this.error = 'Your password must contain at least 12 characters and not exceed 72 UTF-8 bytes.'; return; }
    if (this.password !== this.confirmation) { this.error = 'The passwords do not match.'; return; }
    this.loading = true;
    this.auth.register(email, displayName, this.password).subscribe({ next: () => {
      this.loading = false; this.password = ''; this.confirmation = '';
      const requested = this.returnParams.returnUrl;
      const target = requested && /^\/(bets|account|streams\/\d+)$/.test(requested) ? requested : '/account';
      void this.router.navigateByUrl(target);
    }, error: (error) => { this.loading = false; this.password = ''; this.confirmation = ''; this.error = error?.status === 409 ? 'We could not create an account with that email address. Try signing in or use a different address.' : apiError(error); } });
  }
}
