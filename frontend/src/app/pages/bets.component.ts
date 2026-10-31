import { DatePipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Bet } from '../models';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { apiError, betLabels } from '../services/ui-helpers';
@Component({ selector: 'app-bets', standalone: true, imports: [DatePipe, DecimalPipe, NgFor, NgIf, RouterLink], template: `
  <section><div class="page-heading"><div><span class="eyebrow">YOUR ACCOUNT / HISTORY</span><h1>My predictions<span class="heading-dot">.</span></h1><p>Your predictions, verified counts and virtual credits.</p></div><button class="button" (click)="load()" [disabled]="loading">↻ Refresh</button></div><div class="stats-grid"><article class="stat-card"><span class="stat-label">TOTAL PREDICTIONS</span><strong>{{ bets.length }}</strong><span class="stat-note">All time</span></article><article class="stat-card"><span class="stat-label">AWAITING RESULTS</span><strong>{{ pending }}</strong><span class="stat-note">Counting and verification pending</span></article><article class="stat-card highlight-stat"><span class="stat-label">VIRTUAL BALANCE</span><strong>{{ auth.user?.balanceCredits | number:'1.0-0' }} <small>cr</small></strong><span class="stat-note">Virtual credits</span></article></div><div class="loading-state" *ngIf="loading" role="status"><span class="spinner"></span> Loading history…</div><div class="state-panel error-state" *ngIf="error" role="alert"><h3>History unavailable</h3><p>{{ error }}</p></div><div class="table-panel" *ngIf="!loading && !error && bets.length"><table><thead><tr><th>Camera / round</th><th>Your choice</th><th>Stake</th><th>Potential payout</th><th>Status</th><th>Date</th></tr></thead><tbody><tr *ngFor="let bet of bets"><td><strong>{{ bet.streamTitle }}</strong><small class="table-subtitle">{{ bet.marketTitle }}</small></td><td>{{ bet.side === 'over' ? 'Over the threshold' : 'Under or equal' }}</td><td>{{ bet.stakeCredits | number }} cr</td><td>{{ bet.potentialPayoutCredits | number }} cr</td><td><span class="status-pill" [class]="'status-pill ' + bet.status">{{ labels[bet.status] }}</span></td><td class="muted">{{ bet.createdAt | date:'MMM d, y, HH:mm' }}</td></tr></tbody></table></div><div class="state-panel" *ngIf="!loading && !error && !bets.length"><span class="state-icon">◷</span><h3>Your first prediction starts here</h3><p>Choose a camera with an upcoming counting round.</p><a routerLink="/" class="button primary">Explore cameras →</a></div></section>
` })
export class BetsComponent implements OnInit {
  readonly auth = inject(AuthService); private readonly api = inject(ApiService); readonly labels = betLabels;
  bets: Bet[] = []; loading = true; error = '';
  get pending(): number { return this.bets.filter((bet) => bet.status === 'pending').length; }
  ngOnInit(): void { this.load(); }
  load(): void { this.loading = true; this.error = ''; this.api.myBets().subscribe({ next: (bets) => { this.bets = bets; this.loading = false; this.auth.refreshMe().subscribe({ error: () => {} }); }, error: (error) => { this.loading = false; this.error = apiError(error); } }); }
}
