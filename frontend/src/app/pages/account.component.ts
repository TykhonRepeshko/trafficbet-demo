import { DatePipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { environment } from '../../environments/environment';
import { AccountSecurityComponent } from '../components/account-security.component';
import { CreditLedgerEntry } from '../models';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { apiError } from '../services/ui-helpers';

@Component({ selector: 'app-account', standalone: true, imports: [DatePipe, DecimalPipe, NgFor, NgIf, RouterLink, AccountSecurityComponent], template: `
  <section><div class="page-heading"><div><span class="eyebrow">YOUR SPACE</span><h1>My account<span class="heading-dot">.</span></h1><p>Your profile and virtual credit history.</p></div><button class="button compact" type="button" (click)="load()" [disabled]="loading">↻ Refresh</button></div>
    <div class="account-layout" *ngIf="auth.user as user"><article class="panel account-profile"><div class="account-avatar">{{ user.displayName.slice(0, 1) }}</div><span class="eyebrow">PROFILE #{{ user.id }}</span><h2>{{ user.displayName }}</h2><p class="account-email">{{ user.email }}</p><span class="tag neutral">{{ user.role === 'admin' ? 'Administrator' : 'Member' }}</span><div class="account-facts"><span>Joined<strong>{{ user.createdAt | date:'MMM d, y' }}</strong></span><span>Balance<strong>{{ user.balanceCredits | number:'1.0-0' }} cr</strong></span></div><a class="button full-width" routerLink="/bets">My predictions →</a><p class="small-note">{{ preview ? 'This design preview stores data only in the current tab.' : 'Your balance updates when you place a prediction and when its result is verified.' }}</p></article>
    <div class="account-history"><div class="section-toolbar"><div><span class="eyebrow">VIRTUAL CREDITS</span><h2>Balance history</h2></div><span class="tag neutral">{{ ledger.length }} transactions</span></div><p class="small-note">Your latest 100 transactions. Credits are used only in the simulation and have no monetary value.</p><div class="loading-state" *ngIf="loading" role="status"><span class="spinner"></span> Loading history…</div><div class="state-panel error-state" *ngIf="error" role="alert"><h3>History unavailable</h3><p>{{ error }}</p><button class="button" type="button" (click)="load()">Try again</button></div>
      <div class="table-panel" *ngIf="!loading && !error && ledger.length"><table class="ledger-table"><thead><tr><th>Transaction</th><th>Date</th><th>Change</th><th>Balance after</th></tr></thead><tbody><tr *ngFor="let entry of ledger"><td><strong>{{ labels[entry.reason] || entry.reason }}</strong><small class="table-subtitle">#{{ entry.id }}<span *ngIf="entry.betId"> · prediction #{{ entry.betId }}</span></small></td><td>{{ entry.createdAt | date:'MMM d, y, HH:mm' }}</td><td><strong [class.success]="entry.deltaCredits > 0">{{ entry.deltaCredits > 0 ? '+' : '' }}{{ entry.deltaCredits | number:'1.0-0' }} cr</strong></td><td>{{ entry.balanceAfter | number:'1.0-0' }} cr</td></tr></tbody></table></div><div class="state-panel" *ngIf="!loading && !error && !ledger.length"><h3>No transactions yet</h3><p>Your opening credits, prediction stakes, payouts and refunds will appear here.</p></div>
    </div></div>
  <app-account-security *ngIf="!preview"></app-account-security></section>
` })
export class AccountComponent implements OnInit {
  readonly auth = inject(AuthService); private readonly api = inject(ApiService); readonly preview = environment.preview;
  readonly labels: Record<string, string> = { opening: 'Opening credits', stake: 'Prediction stake', payout: 'Result payout', refund: 'Credit refund' };
  ledger: CreditLedgerEntry[] = []; loading = true; error = '';
  ngOnInit(): void { this.load(); }
  load(): void { this.loading = true; this.error = ''; forkJoin({ user: this.auth.refreshMe(), ledger: this.api.myLedger() }).subscribe({ next: ({ ledger }) => { this.ledger = ledger; this.loading = false; }, error: (error) => { this.loading = false; this.error = apiError(error); } }); }
}
