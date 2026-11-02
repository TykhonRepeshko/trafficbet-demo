import { DatePipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { environment } from '../../environments/environment';
import { AccountSecurityComponent } from '../components/account-security.component';
import { CreditLedgerEntry } from '../models';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { IconComponent } from '../components/icon.component';
import { apiError } from '../services/ui-helpers';

@Component({ selector: 'app-account', standalone: true, imports: [DatePipe, DecimalPipe, NgFor, NgIf, RouterLink, AccountSecurityComponent, IconComponent], template: `
  <section class="ac">
    <header class="tb-page-head"><div><h1>My account</h1><p>Your profile and virtual credit history.</p></div><button class="tb-btn tb-btn-sm" type="button" (click)="load()" [disabled]="loading"><app-icon name="refresh" [size]="15"></app-icon>{{ loading ? 'Updating…' : 'Refresh' }}</button></header>
    <div class="ac-grid" *ngIf="auth.user as user">
      <aside class="tb-card ac-profile">
        <div class="ac-avatar">{{ user.displayName.slice(0, 1) }}</div>
        <h2>{{ user.displayName }}</h2>
        <p class="ac-email">{{ user.email }}</p>
        <span class="tb-chip" [class.is-accent]="user.role === 'admin'">{{ user.role === 'admin' ? 'Administrator' : 'Member' }}</span>
        <div class="ac-balance"><span>Balance</span><strong class="tb-num">{{ user.balanceCredits | number:'1.0-0' }} <small>cr</small></strong></div>
        <dl class="ac-facts"><div><dt>Member since</dt><dd>{{ user.createdAt | date:'MMM d, y' }}</dd></div><div><dt>Profile</dt><dd class="tb-num">#{{ user.id }}</dd></div></dl>
        <a class="tb-btn tb-btn-block" routerLink="/bets"><app-icon name="ticket" [size]="16"></app-icon>My predictions</a>
        <p class="ac-note">{{ preview ? 'This design preview stores data only in the current tab.' : 'Your balance changes when you place a prediction and when its result is verified.' }}</p>
      </aside>
      <section class="tb-card ac-ledger">
        <header class="ac-ledger-head"><div><h2>Balance history</h2><p>Your latest 100 transactions.</p></div><span class="tb-chip">{{ ledger.length }} transactions</span></header>
        <div class="tb-loading" *ngIf="loading" role="status"><span class="tb-spinner"></span>Loading history…</div>
        <div class="tb-empty" *ngIf="error" role="alert"><span class="tb-empty-icon"><app-icon name="alert" [size]="24"></app-icon></span><h3>History unavailable</h3><p>{{ error }}</p><button class="tb-btn" type="button" (click)="load()">Try again</button></div>
        <ul class="ac-rows" *ngIf="!loading && !error && ledger.length">
          <li *ngFor="let entry of ledger"><span class="ac-row-icon" [class.is-plus]="entry.deltaCredits > 0"><app-icon [name]="entry.deltaCredits > 0 ? 'plus' : 'minus'" [size]="16"></app-icon></span><div class="ac-row-main"><strong>{{ labels[entry.reason] || entry.reason }}</strong><small class="tb-num">{{ entry.createdAt | date:'MMM d, y, HH:mm' }}<span *ngIf="entry.betId"> · prediction #{{ entry.betId }}</span></small></div><div class="ac-row-amt"><strong class="tb-num" [class.is-plus]="entry.deltaCredits > 0">{{ entry.deltaCredits > 0 ? '+' : '' }}{{ entry.deltaCredits | number:'1.0-0' }} cr</strong><small class="tb-num">Balance {{ entry.balanceAfter | number:'1.0-0' }} cr</small></div></li>
        </ul>
        <div class="tb-empty" *ngIf="!loading && !error && !ledger.length"><span class="tb-empty-icon"><app-icon name="coins" [size]="24"></app-icon></span><h3>No transactions yet</h3><p>Your opening credits, stakes, payouts and refunds will appear here.</p></div>
      </section>
    </div>
    <app-account-security *ngIf="!preview"></app-account-security>
  </section>
` })
export class AccountComponent implements OnInit {
  readonly auth = inject(AuthService); private readonly api = inject(ApiService); readonly preview = environment.preview;
  readonly labels: Record<string, string> = { opening: 'Opening credits', stake: 'Prediction stake', payout: 'Result payout', refund: 'Credit refund' };
  ledger: CreditLedgerEntry[] = []; loading = true; error = '';
  ngOnInit(): void { this.load(); }
  load(): void { this.loading = true; this.error = ''; forkJoin({ user: this.auth.refreshMe(), ledger: this.api.myLedger() }).subscribe({ next: ({ ledger }) => { this.ledger = ledger; this.loading = false; }, error: (error) => { this.loading = false; this.error = apiError(error); } }); }
}
