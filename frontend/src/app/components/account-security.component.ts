import { DatePipe, NgFor, NgIf } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { timeout } from 'rxjs';
import { environment } from '../../environments/environment';
import { apiError } from '../services/ui-helpers';

interface AccountSecurity { sessions: { id: number; createdAt: string; expiresAt: string; current: boolean }[]; }
@Component({ selector: 'app-account-security', standalone: true, imports: [FormsModule, NgFor, NgIf, DatePipe], template: `
  <section class="panel" style="padding:24px;margin-top:24px"><h2>Account security</h2><p class="small-note">Changing your password or revoking a session requires your current password.</p>
  <p *ngIf="error" class="error message" role="alert">{{ error }}</p><p *ngIf="message" class="success message" role="status">{{ message }}</p>
  <button type="button" class="button compact" (click)="load()" [disabled]="busy">Refresh security</button>
  <ng-container *ngIf="state"><label>Current password<input type="password" autocomplete="current-password" [(ngModel)]="password" maxlength="256"></label>
  <h3 style="margin-top:24px">Active sessions</h3><p class="small-note">Session identifiers below cannot be used to sign in. No session token or hash is displayed.</p><div *ngFor="let session of state.sessions" class="source-row"><span>#{{ session.id }} · {{ session.createdAt | date:'MMM d, HH:mm' }} → {{ session.expiresAt | date:'MMM d, HH:mm' }}</span><strong *ngIf="session.current">This session</strong><button *ngIf="!session.current" class="text-button" type="button" (click)="action('revoke', session.id)" [disabled]="busy || !password">Revoke</button></div>
  <details style="margin-top:20px"><summary>Change password</summary><p class="small-note">Use at least 12 characters, at most 72 UTF-8 bytes. Other sessions are revoked.</p><label>New password<input type="password" autocomplete="new-password" [(ngModel)]="newPassword" maxlength="256"></label><button class="button" type="button" (click)="action('password')" [disabled]="busy || !password || !newPassword">Change password</button></details>
  </ng-container></section>
` })
export class AccountSecurityComponent implements OnInit {
  private readonly http = inject(HttpClient); private readonly destroyRef = inject(DestroyRef);
  state?: AccountSecurity; password = ''; newPassword = ''; busy = false; error = ''; message = '';
  ngOnInit(): void { if (!environment.preview) this.load(); }
  load(): void { this.http.get<AccountSecurity>(`${environment.apiUrl}/me/security`, { withCredentials: true }).pipe(timeout(10_000), takeUntilDestroyed(this.destroyRef)).subscribe({ next: (data) => this.state = data, error: (error) => this.error = apiError(error) }); }
  action(action: 'revoke' | 'password', sessionId?: number): void {
    if (this.busy || !this.password || environment.preview) return;
    this.busy = true; this.error = ''; this.message = '';
    this.http.post(`${environment.apiUrl}/me/security/${action}`, { password: this.password, newPassword: this.newPassword, sessionId: sessionId ?? 0 }, { withCredentials: true }).pipe(timeout(15_000), takeUntilDestroyed(this.destroyRef)).subscribe({ next: (data) => { this.busy = false; this.password = this.newPassword = ''; this.message = 'Security settings updated.'; this.load(); }, error: (error) => { this.busy = false; this.password = this.newPassword = ''; this.error = apiError(error); this.load(); } });
  }
}
