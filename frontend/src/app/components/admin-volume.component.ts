import { DOCUMENT, DatePipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { Component, DestroyRef, OnDestroy, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Subscription, timeout } from 'rxjs';
import { CameraStakeVolume, RoundStakeVolume, StakeAmounts, StakeVolumeSnapshot } from '../models';
import { ApiService } from '../services/api.service';
import { apiError } from '../services/ui-helpers';
import { AdminStakeDetailsComponent } from './admin-stake-details.component';

@Component({
  selector: 'app-admin-volume', standalone: true,
  imports: [DatePipe, DecimalPipe, NgFor, NgIf, RouterLink, AdminStakeDetailsComponent],
  template: `
    <section class="stake-volume" aria-labelledby="stake-volume-title" [attr.aria-busy]="refreshing">
      <div class="section-toolbar volume-toolbar"><div><span class="eyebrow">VIRTUAL CREDIT ACTIVITY</span><h2 id="stake-volume-title">Stake volume</h2><p class="muted small-note">Unsettled stakes by camera, round and outcome. Auto-refresh every 5 seconds while this page is visible.</p></div><button class="button compact" type="button" (click)="refresh()" [disabled]="refreshing">{{ refreshing ? 'Updating…' : '↻ Refresh volume' }}</button></div>
      <p class="volume-freshness" *ngIf="snapshot">Snapshot: {{ snapshot.asOf | date:'MMM d, HH:mm:ss' }} · local time <span *ngIf="error">· Update failed — figures may be out of date</span></p>
      <div class="volume-error notice-block" *ngIf="error" role="alert">{{ error }} {{ snapshot ? 'The last successful snapshot is shown below.' : 'Volume is unavailable; it has not been replaced with zero.' }} <button class="text-button" type="button" (click)="refresh()" [disabled]="refreshing">Retry</button></div>
      <div class="loading-state" *ngIf="!snapshot && refreshing" role="status"><span class="spinner"></span> Loading stake volume…</div>
      <ng-container *ngIf="snapshot as volume">
        <div class="volume-summary">
          <article class="volume-stat volume-stat-primary"><span>Unsettled stakes</span><strong>{{ volume.totals.pendingStakeCredits | number:'1.0-0' }} <small>cr</small></strong><p>{{ volume.totals.pendingBetCount | number:'1.0-0' }} pending predictions</p></article>
          <article class="volume-stat"><span>Over · unsettled</span><strong>{{ volume.totals.pendingOverCredits | number:'1.0-0' }} <small>cr</small></strong><p>{{ volume.totals.pendingOverBetCount | number:'1.0-0' }} predictions</p></article>
          <article class="volume-stat"><span>Under or equal · unsettled</span><strong>{{ volume.totals.pendingUnderCredits | number:'1.0-0' }} <small>cr</small></strong><p>{{ volume.totals.pendingUnderBetCount | number:'1.0-0' }} predictions</p></article>
          <article class="volume-stat"><span>All-time stake volume</span><strong>{{ volume.totals.totalStakeCredits | number:'1.0-0' }} <small>cr</small></strong><p>{{ volume.totals.totalBetCount | number:'1.0-0' }} accepted predictions</p></article>
        </div>
        <p class="volume-definition">Unsettled includes pending predictions after the entry deadline and on archived cameras. All-time volume counts each accepted stake once, including settled and refunded stakes. These are virtual credits, not cash or profit.</p>
        <p class="volume-definition" *ngIf="volume.historicalTotals.totalBetCount">Removed sources retain {{ volume.historicalTotals.totalStakeCredits | number:'1.0-0' }} cr in historical stakes, including {{ volume.historicalTotals.refundedStakeCredits | number:'1.0-0' }} cr refunded and {{ volume.historicalTotals.pendingStakeCredits | number:'1.0-0' }} cr unsettled. Their financial history remains included in the totals.</p>
        <div class="volume-history-totals"><span>Settled stakes <strong>{{ volume.totals.settledStakeCredits | number:'1.0-0' }} cr</strong></span><span>Refunded stakes <strong>{{ volume.totals.refundedStakeCredits | number:'1.0-0' }} cr</strong></span><label><input type="checkbox" [checked]="showAllCameras" (change)="showAllCameras = !showAllCameras"> Include archived cameras with no activity</label></div>
        <div class="volume-camera-grid">
          <article class="volume-camera" [class.volume-camera-selected]="selection?.streamId === camera.streamId" *ngFor="let camera of visibleCameras; trackBy: trackCamera">
            <div class="volume-camera-heading"><div><span class="eyebrow">CAM / {{ camera.streamId }} · {{ camera.city }}</span><h3><button class="volume-name-button" type="button" (click)="selectCamera(camera)">{{ camera.title }} <span aria-hidden="true">↗</span></button></h3><span class="tag neutral" *ngIf="!camera.isActive">Archived · stakes still tracked</span></div><div class="volume-camera-total"><span>Unsettled</span><strong>{{ camera.pendingStakeCredits | number:'1.0-0' }} <small>cr</small></strong></div></div>
            <div class="volume-outcomes"><div><span>Over</span><strong>{{ camera.pendingOverCredits | number:'1.0-0' }} cr</strong><small>{{ camera.pendingOverBetCount | number:'1.0-0' }} pending</small></div><div class="under"><span>Under or equal</span><strong>{{ camera.pendingUnderCredits | number:'1.0-0' }} cr</strong><small>{{ camera.pendingUnderBetCount | number:'1.0-0' }} pending</small></div></div>
            <div class="volume-split" *ngIf="camera.pendingStakeCredits > 0" aria-hidden="true"><span [style.width.%]="overShare(camera)"></span></div>
            <div class="volume-camera-history"><span>All-time <strong>{{ camera.totalStakeCredits | number:'1.0-0' }} cr</strong></span><span>Settled <strong>{{ camera.settledStakeCredits | number:'1.0-0' }} cr</strong></span><span>Refunded <strong>{{ camera.refundedStakeCredits | number:'1.0-0' }} cr</strong></span></div>
            <details class="volume-round-details"><summary>Open and unsettled rounds <span>{{ camera.rounds.length }}</span></summary>
              <div class="table-panel" *ngIf="camera.rounds.length"><table class="volume-round-table"><thead><tr><th>Round / threshold</th><th>Over</th><th>Under or equal</th><th>Unsettled</th></tr></thead><tbody><tr *ngFor="let round of camera.rounds; trackBy: trackRound"><td><button class="volume-round-button" type="button" (click)="selectRound(camera, round)">#{{ round.marketId }} · {{ phase(round, camera) }} ↗</button><small class="table-subtitle">{{ round.title }}</small><small class="table-subtitle">Threshold {{ round.threshold | number:'1.0-0' }} · {{ round.bettingClosesAt | date:'MMM d, HH:mm' }} deadline</small><a *ngIf="camera.isActive" class="text-button" [routerLink]="['/streams', camera.streamId]" [queryParams]="{ round: round.marketId }" [fragment]="'round-' + round.marketId">Inspect round ↗</a></td><td>{{ round.pendingOverCredits | number:'1.0-0' }} cr<small class="table-subtitle">{{ round.pendingOverBetCount }} pending</small></td><td>{{ round.pendingUnderCredits | number:'1.0-0' }} cr<small class="table-subtitle">{{ round.pendingUnderBetCount }} pending</small></td><td><strong>{{ round.pendingStakeCredits | number:'1.0-0' }} cr</strong><small class="table-subtitle">{{ round.pendingBetCount }} pending</small><small class="table-subtitle">{{ round.totalStakeCredits | number:'1.0-0' }} cr all-time</small></td></tr></tbody></table></div>
              <p class="volume-no-rounds" *ngIf="!camera.rounds.length">No rounds accepting predictions or holding unsettled stakes. Historical totals remain above.</p>
            </details>
            <button class="button compact volume-view-stakes" type="button" (click)="selectCamera(camera)">View individual stakes ↗</button>
            <app-admin-stake-details *ngIf="selection?.streamId === camera.streamId" [streamId]="camera.streamId" [cameraTitle]="camera.title" [marketId]="selection?.marketId" [roundTitle]="selection?.roundTitle || ''" (closed)="selection = undefined"></app-admin-stake-details>
          </article>
        </div>
        <div class="state-panel" *ngIf="!visibleCameras.length"><h3>No camera activity yet</h3><p>Available cameras and any archived cameras with prediction history appear here.</p></div>
      </ng-container>
    </section>
  `
})
export class AdminVolumeComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  snapshot?: StakeVolumeSnapshot;
  refreshing = false;
  error = '';
  showAllCameras = false;
  selection?: { streamId: number; marketId?: number; roundTitle?: string };
  private request?: Subscription;
  private timer?: number;
  private generation = 0;
  private destroyed = false;
  private readonly visibilityChanged = (): void => { if (!this.document.hidden) this.refresh(); };

  get visibleCameras(): CameraStakeVolume[] { return this.snapshot?.cameras.filter((camera) => this.showAllCameras || camera.isActive || camera.totalBetCount > 0) ?? []; }
  trackCamera(_index: number, camera: CameraStakeVolume): number { return camera.streamId; }
  trackRound(_index: number, round: RoundStakeVolume): number { return round.marketId; }
  selectCamera(camera: CameraStakeVolume): void { this.selection = { streamId: camera.streamId }; }
  selectRound(camera: CameraStakeVolume, round: RoundStakeVolume): void { this.selection = { streamId: camera.streamId, marketId: round.marketId, roundTitle: round.title }; }
  overShare(amounts: StakeAmounts): number { return amounts.pendingStakeCredits > 0 ? Math.min(100, Math.max(0, amounts.pendingOverCredits * 100 / amounts.pendingStakeCredits)) : 0; }
  phase(round: RoundStakeVolume, camera: CameraStakeVolume): string {
    const now = Date.parse(this.snapshot?.asOf ?? '');
    if (round.status !== 'open') return 'Awaiting review';
    if (now >= Date.parse(round.windowEnd)) return 'Awaiting verification';
    if (now >= Date.parse(round.windowStart)) return 'Counting';
    if (now >= Date.parse(round.bettingClosesAt)) return 'Entries closed';
    return camera.isActive ? 'Entries open' : 'Camera archived';
  }
  ngOnInit(): void {
    this.document.addEventListener('visibilitychange', this.visibilityChanged);
    this.refresh();
    this.timer = this.document.defaultView?.setInterval(() => this.refresh(), 5000);
  }
  ngOnDestroy(): void {
    this.destroyed = true; this.generation++; this.request?.unsubscribe();
    if (this.timer !== undefined) this.document.defaultView?.clearInterval(this.timer);
    this.document.removeEventListener('visibilitychange', this.visibilityChanged);
  }
  refresh(): void {
    if (this.destroyed || this.document.hidden || this.refreshing) return;
    this.request?.unsubscribe();
    const generation = ++this.generation;
    this.refreshing = true;
    this.request = this.api.stakeVolume().pipe(timeout(8000), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (snapshot) => { if (generation !== this.generation) return; this.snapshot = snapshot; this.error = ''; this.refreshing = false; },
      error: (error) => { if (generation !== this.generation) return; this.error = apiError(error); this.refreshing = false; }
    });
  }
}
