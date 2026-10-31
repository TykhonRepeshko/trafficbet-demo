import { DatePipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Subscription, timeout } from 'rxjs';
import { Bet } from '../models';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { apiError, predictionLabel, betLabels } from '../services/ui-helpers';

@Component({
  selector: 'app-bets', standalone: true,
  imports: [DatePipe, DecimalPipe, NgFor, NgIf, RouterLink],
  styleUrl: './bets.component.css',
  template: `
    <section class="prediction-history">
      <div class="page-heading"><div><span class="eyebrow">YOUR ACCOUNT / HISTORY</span><h1>My predictions<span class="heading-dot">.</span></h1><p>Track your accepted stakes, results and returned credits.</p></div><div class="history-actions"><a class="button primary" routerLink="/">New prediction →</a><button class="button" type="button" (click)="load()" [disabled]="loading">{{ loading ? 'Updating…' : 'Refresh' }}</button></div></div>
      <div class="stats-grid">
        <article class="stat-card"><span class="stat-label">PREDICTIONS</span><strong>{{ loading || error ? '—' : bets.length }}</strong><span class="stat-note">Accepted stakes</span></article>
        <article class="stat-card"><span class="stat-label">AWAITING RESULTS</span><strong>{{ loading || error ? '—' : pending }}</strong><span class="stat-note">Counting or verification pending</span></article>
        <article class="stat-card highlight-stat"><span class="stat-label">AVAILABLE BALANCE</span><strong>{{ auth.user?.balanceCredits | number:'1.0-0' }} <small>cr</small></strong><span class="stat-note">Virtual credits</span></article>
      </div>
      <div class="loading-state" *ngIf="loading" role="status"><span class="spinner"></span> Loading your predictions…</div>
      <div class="state-panel error-state" *ngIf="error" role="alert"><h3>History unavailable</h3><p>{{ error }}</p><button class="button" type="button" (click)="load()">Try again</button></div>
      <ng-container *ngIf="!loading && !error">
        <div class="history-toolbar" *ngIf="bets.length"><div class="history-filters" role="group" aria-label="Filter prediction history"><button type="button" [attr.aria-pressed]="filter === 'all'" (click)="filter = 'all'">All <span>{{ bets.length }}</span></button><button type="button" [attr.aria-pressed]="filter === 'pending'" (click)="filter = 'pending'">Awaiting results <span>{{ pending }}</span></button></div><p>Returns include your stake. A potential return is credited only if the prediction wins.</p></div>
        <div class="prediction-history-grid" *ngIf="visibleBets.length">
          <article class="history-card" *ngFor="let bet of visibleBets; trackBy: trackBet" [attr.aria-label]="'Prediction ' + bet.id + ' for round ' + bet.marketId">
            <header><span class="history-reference">Prediction #{{ bet.id }} · Round #{{ bet.marketId }}</span><span [class]="'status-pill ' + bet.status">{{ labels[bet.status] }}</span></header>
            <h2>{{ bet.streamTitle || 'Camera prediction' }}</h2><p class="history-round-title" *ngIf="bet.marketTitle">{{ bet.marketTitle }}</p>
            <div class="history-choice"><span>Your prediction</span><strong>{{ predictionLabel(bet) }}</strong></div>
            <dl class="history-amounts"><div><dt>Staked</dt><dd>{{ bet.stakeCredits | number:'1.0-0' }} <small>cr</small></dd></div><div><dt>{{ returnLabel(bet) }}</dt><dd>{{ returnAmount(bet) | number:'1.0-0' }} <small>cr</small><span class="return-hint">{{ returnHint(bet) }}</span></dd></div></dl>
            <footer><time [attr.datetime]="bet.createdAt">Placed {{ bet.createdAt | date:'MMM d, y, HH:mm:ss' }}</time><span *ngIf="bet.settledAt">{{ bet.status === 'void' ? 'Refunded' : 'Settled' }} {{ bet.settledAt | date:'MMM d, HH:mm:ss' }}</span></footer>
          </article>
        </div>
        <div class="state-panel" *ngIf="bets.length && !visibleBets.length"><h3>No predictions awaiting results</h3><p>Your completed predictions are available under All.</p><button class="button" type="button" (click)="filter = 'all'">Show all predictions</button></div>
        <div class="state-panel" *ngIf="!bets.length"><span class="state-icon" aria-hidden="true">◷</span><h3>Your first prediction starts here</h3><p>Choose a camera, enter a vehicle-count range and confirm your virtual stake.</p><a routerLink="/" class="button primary">Find a camera →</a></div>
      </ng-container>
    </section>
  `,
})
export class BetsComponent implements OnInit {
  readonly predictionLabel = predictionLabel;
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);
  readonly labels: Record<string, string> = { ...betLabels, pending: 'Awaiting result' };
  bets: Bet[] = []; loading = true; error = '';
  filter: 'all' | 'pending' = 'all';
  private request?: Subscription;
  get pending(): number { return this.bets.filter(bet => bet.status === 'pending').length; }
  get visibleBets(): Bet[] { return this.filter === 'pending' ? this.bets.filter(bet => bet.status === 'pending') : this.bets; }
  trackBet(_index: number, bet: Bet): number { return bet.id; }
  returnAmount(bet: Bet): number { return bet.status === 'pending' || bet.status === 'won' ? bet.potentialPayoutCredits : bet.status === 'void' ? bet.stakeCredits : 0; }
  returnLabel(bet: Bet): string { return bet.status === 'pending' ? 'Potential return' : bet.status === 'void' ? 'Refunded' : 'Returned'; }
  returnHint(bet: Bet): string { return bet.status === 'pending' ? 'If you win · includes your stake' : bet.status === 'won' ? 'Winning return · includes your stake' : bet.status === 'void' ? 'Original stake returned' : 'Stake lost · no credits returned'; }
  ngOnInit(): void { this.load(); }
  load(): void {
    this.request?.unsubscribe(); this.loading = true; this.error = '';
    this.request = this.api.myBets().pipe(timeout(10000), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: bets => { this.bets = bets; this.loading = false; this.auth.refreshMe().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ error: () => {} }); },
      error: error => { this.loading = false; this.error = apiError(error); },
    });
  }
}
