import { DatePipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription, catchError, combineLatest, forkJoin, map, of, throwError, timeout } from 'rxjs';
import { CountingRulesComponent } from '../components/counting-rules.component';
import { LiveCameraCounterComponent } from '../components/live-camera-counter.component';
import { VideoPlayerComponent } from '../components/video-player.component';
import { CountingSnapshot, LiveRound, Market, TrafficStream } from '../models';
import { ApiService } from '../services/api.service';
import { roundPhase, roundPhaseLabels } from '../services/round-state';
import { apiError, voidReasonLabel } from '../services/ui-helpers';

export function positiveRouteId(value: string | null): number | undefined {
  return value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
}

@Component({ selector: 'app-admin-camera', standalone: true,
  imports: [DatePipe, DecimalPipe, NgFor, NgIf, RouterLink, VideoPlayerComponent, LiveCameraCounterComponent, CountingRulesComponent],
  templateUrl: './admin-camera.component.html', styleUrl: './admin-camera.component.css' })
export class AdminCameraComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  stream?: TrafficStream; selected?: Market; snapshot?: CountingSnapshot; live?: LiveRound;
  rounds: Market[] = []; cameraId = 0; selectedId?: number;
  loading = true; refreshing = false; error = ''; refreshError = ''; liveError = '';
  now = Date.now(); updatedAt?: Date;
  private context = ''; private generation = 0; private destroyed = false;
  private routeSub?: Subscription; private request?: Subscription; private liveRequest?: Subscription; private timer?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.routeSub = combineLatest([this.route.paramMap, this.route.queryParamMap]).subscribe(([params, query]) => {
      const values = query.getAll('round'), id = positiveRouteId(params.get('id'));
      const round = values.length === 1 ? positiveRouteId(values[0]) : undefined;
      const key = `${params.get('id')}:${values.join(',')}`;
      if (key === this.context) return;
      this.context = key; this.generation++; this.request?.unsubscribe(); this.liveRequest?.unsubscribe();
      this.stream = undefined; this.selected = undefined; this.snapshot = undefined; this.live = undefined; this.rounds = [];
      this.error = ''; this.refreshError = ''; this.liveError = ''; this.selectedId = round; this.refreshing = false;
      if (!id || (values.length > 0 && !round)) { this.cameraId = 0; this.loading = false; this.error = 'Invalid camera or round address.'; return; }
      this.cameraId = id; this.load();
    });
    this.timer = setInterval(() => { this.now = Date.now(); if (!document.hidden && !this.error) this.load(true); }, 5000);
  }
  ngOnDestroy(): void {
    this.destroyed = true; this.generation++; this.routeSub?.unsubscribe(); this.request?.unsubscribe(); this.liveRequest?.unsubscribe();
    if (this.timer) clearInterval(this.timer);
  }
  load(background = false): void {
    if (this.refreshing || !this.cameraId || this.destroyed) return;
    const generation = ++this.generation, id = this.cameraId, target = this.selectedId;
    this.request?.unsubscribe(); this.liveRequest?.unsubscribe(); this.refreshing = true; this.loading = !background; this.refreshError = '';
    const camera = this.api.getStream(id).pipe(catchError(error => error.status === 404
      ? this.api.adminStreams().pipe(map(streams => { const archived = streams.find(s => s.id === id && !s.isActive); if (!archived) throw error; return archived; }))
      : throwError(() => error)));
    this.request = forkJoin({ stream: camera, markets: this.api.listMarkets(), detail: target ? this.api.roundReview(target) : of(undefined) })
      .pipe(timeout(12000)).subscribe({ next: data => {
        if (this.destroyed || generation !== this.generation) return;
        this.refreshing = false; this.loading = false;
        if (data.detail && (data.detail.market.id !== target || data.detail.market.streamId !== id)) {
          this.error = 'This round belongs to another camera. Open it from its original camera.'; this.selected = undefined; this.snapshot = undefined; this.live = undefined; return;
        }
        if (JSON.stringify(this.stream) !== JSON.stringify(data.stream)) this.stream = data.stream;
        this.now = Date.now(); this.updatedAt = new Date();
        const cameraRounds = data.markets.filter(m => m.streamId === id).sort((a, b) => Date.parse(b.windowStart) - Date.parse(a.windowStart) || b.id - a.id);
        this.rounds = cameraRounds.slice(0, 30);
        const selected = data.detail?.market ?? (target ? this.rounds.find(m => m.id === target) : this.initialRound(cameraRounds));
        this.selected = selected; this.selectedId = selected?.id; this.snapshot = data.detail?.snapshot ?? selected?.countingRules;
        if (selected && !this.rounds.some(m => m.id === selected.id)) this.rounds.unshift(selected);
        if (target && !selected) { this.error = 'The requested round could not be loaded.'; return; }
        this.error = ''; this.loadLive(generation);
      }, error: error => {
        if (this.destroyed || generation !== this.generation) return;
        this.refreshing = false; this.loading = false;
        if (background && this.stream) this.refreshError = apiError(error, 'Could not update this camera. Displayed round information may be out of date.');
        else this.error = apiError(error);
      } });
  }
  private initialRound(rows: Market[]): Market | undefined {
    const ordered = [...rows].sort((a, b) => Date.parse(a.windowStart) - Date.parse(b.windowStart) || a.id - b.id);
    return ordered.find(m => this.phase(m) === 'counting') ?? ordered.find(m => this.phase(m) === 'verifying')
      ?? ordered.find(m => ['locked', 'open'].includes(this.phase(m))) ?? rows[0];
  }
  private loadLive(generation: number): void {
    this.live = undefined; this.liveError = '';
    const market = this.selected;
    if (!market || market.status !== 'open') return;
    this.liveRequest = this.api.liveRound(market.id).pipe(timeout(8000)).subscribe({ next: live => {
      if (generation === this.generation && this.selected?.id === live.marketId && live.streamId === this.cameraId) this.live = live;
    }, error: () => { if (generation === this.generation) this.liveError = 'AI progress is unavailable. The round result is still pending.'; } });
  }
  selectRound(market: Market): void {
    if (market.streamId !== this.cameraId) return;
    void this.router.navigate(['/admin/cameras', this.cameraId], { queryParams: { round: market.id }, fragment: 'selected-round' });
  }
  phase(market: Market) { return roundPhase(market, this.now); }
  phaseLabel(market: Market): string { return roundPhaseLabels[this.phase(market)]; }
  get ended(): boolean { return !!this.selected && Date.parse(this.selected.windowEnd) <= this.now; }
  get processedCount(): number | undefined { return this.live?.live?.vehicleCount; }
  get processedUntil(): number | undefined { return this.live?.live?.processedUntil; }
  refundReason(market: Market): string { return voidReasonLabel(market.voidReason); }
  trackRound(_index: number, market: Market): number { return market.id; }
  cameraNumber(id: number): string { return String(id).padStart(3, '0'); }
}
