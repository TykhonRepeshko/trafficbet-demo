import { DatePipe, DecimalPipe, NgClass, NgFor, NgIf } from '@angular/common';
import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Subscription, timeout } from 'rxjs';
import { Bet } from '../models';
import { IconComponent } from '../components/icon.component';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { apiError, predictionLabel, betLabels, voidReasonLabel } from '../services/ui-helpers';

@Component({
  selector: 'app-bets', standalone: true,
  imports: [DatePipe, DecimalPipe, NgClass, NgFor, NgIf, RouterLink, IconComponent],
  styleUrl: './bets.component.css',
  template: `
    <section class="bh">
      <header class="tb-page-head">
        <div><h1>My predictions</h1><p>Track your stakes, results and returned credits.</p></div>
        <div class="bh-actions"><button class="tb-btn tb-btn-sm" type="button" (click)="load()" [disabled]="loading"><app-icon name="refresh" [size]="15"></app-icon>{{ loading ? 'Updating…' : 'Refresh' }}</button><a class="tb-btn tb-btn-primary tb-btn-sm" routerLink="/">New prediction<app-icon name="arrow" [size]="15"></app-icon></a></div>
      </header>
      <div class="bh-stats">
        <article class="tb-card bh-stat"><span class="bh-stat-icon"><app-icon name="ticket"></app-icon></span><div><span>Predictions</span><strong class="tb-num">{{ loading || error ? '—' : bets.length }}</strong></div></article>
        <article class="tb-card bh-stat"><span class="bh-stat-icon is-warn"><app-icon name="clock"></app-icon></span><div><span>Awaiting result</span><strong class="tb-num">{{ loading || error ? '—' : pending }}</strong></div></article>
        <article class="tb-card bh-stat"><span class="bh-stat-icon is-accent"><app-icon name="coins"></app-icon></span><div><span>Available balance</span><strong class="tb-num">{{ auth.user?.balanceCredits | number:'1.0-0' }} <small>cr</small></strong></div></article>
      </div>
      <div class="tb-loading" *ngIf="loading" role="status"><span class="tb-spinner"></span>Loading your predictions…</div>
      <div class="tb-card tb-empty" *ngIf="error" role="alert"><span class="tb-empty-icon"><app-icon name="alert" [size]="24"></app-icon></span><h3>History unavailable</h3><p>{{ error }}</p><button class="tb-btn" type="button" (click)="load()">Try again</button></div>
      <ng-container *ngIf="!loading && !error">
        <div class="bh-toolbar" *ngIf="bets.length"><div class="tb-seg" role="group" aria-label="Filter prediction history"><button type="button" [attr.aria-pressed]="filter === 'all'" (click)="filter = 'all'">All <span>{{ bets.length }}</span></button><button type="button" [attr.aria-pressed]="filter === 'pending'" (click)="filter = 'pending'">Awaiting result <span>{{ pending }}</span></button></div><p>Returns include your stake.</p></div>
        <div class="bh-list" *ngIf="visibleBets.length">
          <article class="tb-card bh-item" *ngFor="let bet of visibleBets; trackBy: trackBet" [attr.aria-label]="'Prediction ' + bet.id + ' for round ' + bet.marketId" [ngClass]="'is-' + bet.status">
            <div class="bh-item-main">
              <span class="tb-chip" [class.is-open]="bet.status === 'won'" [class.is-danger]="bet.status === 'lost'" [class.is-warn]="bet.status === 'pending'" [class.is-info]="bet.status === 'void'"><span class="tb-dot" [class.is-pulse]="bet.status === 'pending'"></span>{{ labels[bet.status] }}</span>
              <h2>{{ bet.streamTitle || 'Camera prediction' }}</h2>
              <p class="bh-meta tb-num">Round #{{ bet.marketId }} · <time [attr.datetime]="bet.createdAt">{{ bet.createdAt | date:'MMM d, HH:mm:ss' }}</time><span *ngIf="bet.settledAt"> · {{ bet.status === 'void' ? 'refunded' : 'settled' }} {{ bet.settledAt | date:'HH:mm' }}</span></p>
              <p class="bh-result" *ngIf="bet.actualCount !== undefined && bet.actualCount !== null"><app-icon name="eye" [size]="14"></app-icon>AI count: <strong class="tb-num">{{ bet.actualCount }} {{ bet.actualCount === 1 ? 'vehicle' : 'vehicles' }}</strong></p>
              <p class="bh-result is-void" *ngIf="bet.status === 'void'"><app-icon name="info" [size]="14"></app-icon>{{ voidReasonLabel(bet.voidReason) }}</p>
            </div>
            <div class="bh-cell"><span>Your pick</span><strong class="tb-num">{{ predictionLabel(bet) }}</strong></div>
            <div class="bh-cell"><span>Stake</span><strong class="tb-num">{{ bet.stakeCredits | number:'1.0-0' }} cr</strong></div>
            <div class="bh-cell bh-return"><span>{{ returnLabel(bet) }}</span><strong class="tb-num">{{ returnAmount(bet) | number:'1.0-0' }} cr</strong><small>{{ returnHint(bet) }}</small></div>
          </article>
        </div>
        <div class="tb-card tb-empty" *ngIf="bets.length && !visibleBets.length"><span class="tb-empty-icon"><app-icon name="check" [size]="24"></app-icon></span><h3>Nothing awaiting results</h3><p>All your predictions have been settled.</p><button class="tb-btn" type="button" (click)="filter = 'all'">Show all predictions</button></div>
        <div class="tb-card tb-empty" *ngIf="!bets.length"><span class="tb-empty-icon"><app-icon name="ticket" [size]="24"></app-icon></span><h3>Your first prediction starts here</h3><p>Pick a camera, guess the vehicle count and stake some virtual credits.</p><a routerLink="/" class="tb-btn tb-btn-primary">Find a camera<app-icon name="arrow" [size]="16"></app-icon></a></div>
      </ng-container>
    </section>
  `,
})
export class BetsComponent implements OnInit {
  readonly predictionLabel = predictionLabel;
  readonly voidReasonLabel = voidReasonLabel;
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
