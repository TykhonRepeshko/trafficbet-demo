import { NgIf } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { environment } from '../../environments/environment';
import { AuthService } from '../services/auth.service';
import { apiError } from '../services/ui-helpers';

@Component({ selector: 'app-register', standalone: true, imports: [FormsModule, NgIf, RouterLink], template: `
  <section class="login-layout">
    <div class="login-story"><span class="eyebrow">CAMERAS. PREDICTIONS. YOUR RESULTS.</span><h1>Your perspective<br>on a moving city<span class="heading-dot">.</span></h1><p>Create an account to test your predictions on real city traffic. Your history and virtual balance stay with you between visits.</p><div class="login-orbit"><span>↗</span><i></i><b>TRAFFIC / LAB</b></div></div>
    <div class="panel login-panel"><span class="eyebrow">NEW ACCOUNT</span><h2>Create account</h2><p class="muted">One account for cameras, predictions and balance history. Start with 10,000 virtual credits when you join.</p>
      <p *ngIf="preview" class="notice">This is a standalone design preview. Open the main application to create a persistent account.</p>
      <form *ngIf="!preview" class="form-grid" (ngSubmit)="form.valid && submit()" #form="ngForm">
        <label>Display name<input name="displayName" autocomplete="nickname" [(ngModel)]="displayName" placeholder="What should we call you?" minlength="2" maxlength="80" required></label>
        <label>Email address<input name="email" type="email" autocomplete="username" [(ngModel)]="email" placeholder="you@example.com" maxlength="254" required email></label>
        <label>Password<input name="password" type="password" autocomplete="new-password" [(ngModel)]="password" placeholder="At least 12 characters" minlength="12" maxlength="72" required aria-describedby="password-requirements"><small id="password-requirements" class="field-hint">At least 12 characters, up to 72 UTF-8 bytes. Use a unique password.</small></label>
        <label>Confirm password<input name="confirmation" type="password" autocomplete="new-password" [(ngModel)]="confirmation" placeholder="Enter your password again" maxlength="72" required></label>
        <p class="error message" *ngIf="error" role="alert">{{ error }}</p>
        <button class="button primary" type="submit" [disabled]="loading || form.invalid">{{ loading ? 'Creating account…' : 'Create an account' }} <span>→</span></button>
      </form>
      <p class="auth-switch">Already have an account? <a routerLink="/login" [queryParams]="returnParams">Sign in</a></p>
      <p class="login-note">Virtual credits only. Credits cannot be purchased, withdrawn or exchanged for money.</p><a routerLink="/" class="text-link">← Back to cameras</a>
    </div>
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
