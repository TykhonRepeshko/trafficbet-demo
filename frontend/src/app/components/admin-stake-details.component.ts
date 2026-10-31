import { DOCUMENT, DatePipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { Component, DestroyRef, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Subscription, timeout } from 'rxjs';
import { AdminStakeBet, BetStatus, StakeBetPage } from '../models';
import { ApiService } from '../services/api.service';
import { apiError, predictionLabel, betLabels } from '../services/ui-helpers';

@Component({ selector: 'app-admin-stake-details', standalone: true, imports: [DatePipe, DecimalPipe, NgFor, NgIf, FormsModule], template: `
  <section class="stake-inspector" aria-labelledby="stake-inspector-title" [attr.aria-busy]="loading">
    <div class="stake-inspector-heading"><div><span class="eyebrow">INDIVIDUAL PREDICTIONS · ADMIN ONLY</span><h4 id="stake-inspector-title">{{ cameraTitle }}{{ marketId ? ' · Round #' + marketId : ' · All rounds' }}</h4><p *ngIf="marketId">{{ roundTitle }}</p></div><button type="button" class="button compact" (click)="closed.emit()">Close details</button></div>
    <div class="stake-inspector-controls"><label>Status<select name="stakeStatus" [ngModel]="status" (ngModelChange)="changeStatus($event)"><option value="pending">Unsettled</option><option value="all">All history</option><option value="won">Won</option><option value="lost">Lost</option><option value="void">Refunded</option></select></label><label>Per page<select name="stakePageSize" [ngModel]="pageSize" (ngModelChange)="changePageSize($event)"><option [ngValue]="10">10</option><option [ngValue]="25">25</option><option [ngValue]="50">50</option><option [ngValue]="100">100</option></select></label><button class="button compact" type="button" (click)="refresh()" [disabled]="loading">{{ loading ? 'Updating…' : '↻ Refresh details' }}</button></div>
    <p class="volume-freshness" *ngIf="result">Updated {{ result.asOf | date:'MMM d, HH:mm:ss' }} · local time · Auto-refresh every 5 seconds</p>
    <p class="volume-error" role="alert" *ngIf="error">{{ error }} {{ result ? 'The previous snapshot for this selection is shown; it may be out of date.' : '' }} <button type="button" class="text-button" (click)="refresh()" [disabled]="loading">Retry</button></p>
    <div class="loading-state" role="status" *ngIf="loading && !result"><span class="spinner"></span> Loading individual predictions…</div>
    <ng-container *ngIf="result as pageData"><p class="stake-inspector-count" role="status">Showing {{ rangeStart }}–{{ rangeEnd }} of {{ pageData.total | number:'1.0-0' }} predictions · <strong>{{ pageData.stakeCredits | number:'1.0-0' }} cr</strong> across all matching pages</p>
      <div class="table-panel" *ngIf="pageData.items.length"><table class="stake-inspector-table"><thead><tr><th>Member</th><th>Round / prediction</th><th>Outcome</th><th>Stake</th><th>Potential return</th><th>Status</th><th>Placed</th></tr></thead><tbody><tr *ngFor="let bet of pageData.items; trackBy: trackBet"><td><strong>{{ bet.displayName }}</strong><small class="table-subtitle">Member #{{ bet.userId }}</small><small class="table-subtitle stake-member-email">{{ bet.email }}</small></td><td><strong>Round #{{ bet.marketId }} · Prediction #{{ bet.id }}</strong><small class="table-subtitle">{{ bet.marketTitle }}</small></td><td>{{ predictionLabel(bet) }}</td><td><strong>{{ bet.stakeCredits | number:'1.0-0' }} cr</strong></td><td>{{ bet.potentialPayoutCredits | number:'1.0-0' }} cr<small class="table-subtitle">Includes original stake</small></td><td><span [class]="'status-pill ' + bet.status">{{ betLabels[bet.status] }}</span></td><td>{{ bet.createdAt | date:'MMM d, HH:mm:ss' }}</td></tr></tbody></table></div>
      <p class="volume-no-rounds" *ngIf="!pageData.items.length">No predictions match this camera, round and status.</p>
      <nav class="admin-user-pagination" aria-label="Individual prediction pages"><div><button class="button compact" type="button" (click)="changePage(1)" [disabled]="loading || page <= 1">First</button><button class="button compact" type="button" (click)="changePage(page - 1)" [disabled]="loading || page <= 1">Previous</button><span>Page {{ page }} of {{ pageData.totalPages }}</span><button class="button compact" type="button" (click)="changePage(page + 1)" [disabled]="loading || page >= pageData.totalPages">Next</button><button class="button compact" type="button" (click)="changePage(pageData.totalPages)" [disabled]="loading || page >= pageData.totalPages">Last</button></div></nav>
    </ng-container>
  </section>
` })
export class AdminStakeDetailsComponent implements OnChanges, OnInit, OnDestroy {
  @Input() streamId = 0;
  @Input() marketId?: number;
  @Input() cameraTitle = '';
  @Input() roundTitle = '';
  @Output() readonly closed = new EventEmitter<void>();
  private readonly api = inject(ApiService);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  readonly predictionLabel = predictionLabel; readonly betLabels = betLabels;
  status: BetStatus | 'all' = 'pending';
  page = 1; pageSize = 25; loading = false; error = '';
  result?: StakeBetPage;
  private scope = '';
  private generation = 0;
  private destroyed = false;
  private request?: Subscription;
  private timer?: number;
  private readonly visible = (): void => { if (!this.document.hidden) this.refresh(); };
  ngOnChanges(): void {
    const scope = `${this.streamId}:${this.marketId ?? ''}`;
    if (scope === this.scope) return;
    this.scope = scope; this.generation++; this.request?.unsubscribe(); this.loading = false;
    this.result = undefined; this.error = ''; this.page = 1; this.status = 'pending'; this.loadPage(1);
  }
  ngOnInit(): void { this.document.addEventListener('visibilitychange', this.visible); this.refresh(); this.timer = this.document.defaultView?.setInterval(() => this.refresh(), 5000); }
  ngOnDestroy(): void { this.destroyed = true; this.generation++; this.request?.unsubscribe(); this.result = undefined; if (this.timer !== undefined) this.document.defaultView?.clearInterval(this.timer); this.document.removeEventListener('visibilitychange', this.visible); }
  get rangeStart(): number { return this.result?.items.length ? (this.result.page - 1) * this.result.pageSize + 1 : 0; }
  get rangeEnd(): number { return this.result?.items.length ? this.rangeStart + this.result.items.length - 1 : 0; }
  trackBet(_index: number, bet: AdminStakeBet): number { return bet.id; }
  refresh(): void { if (!this.loading) this.loadPage(this.page, true); }
  changeStatus(value: BetStatus | 'all'): void { if (['pending', 'all', 'won', 'lost', 'void'].includes(value)) { this.status = value; this.loadPage(1); } }
  changePageSize(value: number): void { if ([10, 25, 50, 100].includes(value)) { this.pageSize = value; this.loadPage(1); } }
  changePage(value: number): void { if (!this.loading && this.result && Number.isInteger(value) && value >= 1 && value <= this.result.totalPages && value !== this.page) this.loadPage(value); }
  private loadPage(page: number, preserve = false): void {
    if (this.destroyed || this.document.hidden || !Number.isInteger(this.streamId) || this.streamId <= 0 || (this.marketId !== undefined && (!Number.isInteger(this.marketId) || this.marketId <= 0))) return;
    const generation = ++this.generation; this.request?.unsubscribe(); this.page = page; this.loading = true;
    if (!preserve) { this.result = undefined; this.error = ''; }
    const streamId = this.streamId, marketId = this.marketId, status = this.status;
    this.request = this.api.stakeDetails(streamId, marketId, status, page, this.pageSize).pipe(timeout(8000), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (result) => {
        if (generation !== this.generation) return;
        this.loading = false;
        if (result.streamId !== streamId || result.marketId !== marketId || result.status !== status) { this.result = undefined; this.error = 'The response did not match the selected camera and round. Please refresh.'; return; }
        this.result = result; this.page = result.page; this.pageSize = result.pageSize; this.error = '';
      },
      error: (error) => { if (generation === this.generation) { this.loading = false; this.error = apiError(error); } }
    });
  }
}
