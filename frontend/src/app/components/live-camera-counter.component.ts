import { NgIf } from '@angular/common';
import { Component, Input, OnChanges, OnDestroy, inject } from '@angular/core';
import { Subscription, forkJoin, timeout } from 'rxjs';
import { LiveRound, Market, TrafficStream } from '../models';
import { ApiService } from '../services/api.service';
import { LivePhase, aiBehind, liveCount, livePhase, mmss, pickObservedMarket } from '../services/play-logic';
import type { VideoPlayerComponent } from './video-player.component';

/** A public, read-only counter for watching a camera without placing a prediction. */
@Component({
  selector: 'app-live-camera-counter', standalone: true, imports: [NgIf],
  template: `<div class="camera-counter" *ngIf="visible" role="group" aria-label="Live AI vehicle counter" [class.is-live]="phase === 'counting' && !behind" [class.is-waiting]="behind || unavailable">
    <div class="counter-value"><small>AI count<span *ngIf="market"> · #{{ market.id }}</span></small><strong class="tb-num">{{ count === null ? '—' : count }}<em *ngIf="behind && count !== null">+</em></strong></div>
    <span class="counter-status"><span class="tb-spinner" *ngIf="behind || unavailable"></span>{{ statusText }}</span>
  </div>`,
  styles: [`:host{position:absolute;left:14px;bottom:14px;z-index:4;pointer-events:none}.camera-counter{display:flex;align-items:center;gap:14px;padding:10px 16px 10px 12px;max-width:calc(100vw - 52px);border:1px solid #ffffff2b;border-radius:18px;background:#080e16e8;color:#fff;box-shadow:0 8px 24px #0005;backdrop-filter:blur(8px)}.is-live{border-color:#42f587;box-shadow:0 0 0 1px #42f58755,0 8px 24px #0005}.is-waiting{border-color:#ffd28a}.counter-value{display:grid;justify-items:center;min-width:64px}.counter-value small{font-size:10px;font-weight:760;letter-spacing:.06em;text-transform:uppercase;opacity:.75}.counter-value strong{font-size:42px;line-height:1;font-weight:820}.counter-value em{font-size:22px;font-style:normal}.counter-status{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:700}.tb-spinner{width:13px;height:13px;border-width:2px;border-color:#ffffff55;border-top-color:#fff}@media(max-width:600px){:host{left:8px;bottom:8px}.camera-counter{padding:6px 10px;gap:8px;border-radius:14px}.counter-value strong{font-size:30px}.counter-status{font-size:11px}}`]
})
export class LiveCameraCounterComponent implements OnChanges, OnDestroy {
  private readonly api = inject(ApiService);
  @Input() stream?: TrafficStream;
  @Input() player?: VideoPlayerComponent;
  @Input() enabled = true;
  market?: Market;
  round?: LiveRound;
  displayed: number | null = null;
  count: number | null = null;
  phase: LivePhase = 'waiting';
  behind = false;
  unavailable = false;
  private lastDisplayed: number | null = null;
  private automatic?: boolean;
  private identity = '';
  private timer?: number;
  private discoverSub?: Subscription;
  private liveSub?: Subscription;
  private nextDiscover = 0;
  private nextProgress = 0;
  private generation = 0;
  private now = Date.now();

  get visible(): boolean { return this.enabled && this.stream?.streamType === 'hls' && this.automatic !== false; }
  get snapshot() { return this.market?.countingRules; }
  get crossings() { return this.round?.status === 'void' || this.unavailable ? undefined : this.round?.live?.crossings; }
  get highlights() { return this.round?.status === 'void' || this.unavailable ? undefined : this.round?.live?.highlights; }
  get statusText(): string {
    if (this.unavailable) return 'Counter reconnecting…';
    if (!this.market) return 'Waiting for a counting round';
    if (this.round?.status === 'void') return 'Round unverified';
    if (Date.parse(this.market.windowStart)>this.now) return `Starts in ${mmss((Date.parse(this.market.windowStart)-this.now)/1000)}`;
    if (!this.round?.live) return 'Waiting for AI…';
    if (this.displayed === null && this.lastDisplayed !== null) return 'Synchronizing video…';
    if (this.phase === 'syncing') return 'Waiting for video…';
    if (this.behind) return 'AI catching up…';
    if (this.phase === 'counting') return `Live · ${mmss(Date.parse(this.market.windowEnd)/1000-(this.displayed ?? this.now/1000))}`;
    return this.phase === 'result' ? 'Final' : 'Confirming…';
  }

  ngOnChanges(): void {
    const identity = this.enabled && this.stream?.streamType === 'hls'
      ? `${this.stream.id}:${this.stream.countingGuide?.sourceFingerprint ?? this.stream.streamUrl}` : '';
    if (identity === this.identity) return;
    this.stop(); this.identity = identity;
    if (identity) { this.tick(); this.timer = window.setInterval(() => this.tick(), 250); }
  }
  ngOnDestroy(): void { this.stop(); this.identity = ''; }

  private stop(): void {
    this.generation++;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = undefined;
    this.discoverSub?.unsubscribe(); this.liveSub?.unsubscribe();
    if (this.round) this.player?.releaseAnalysisSync();
    this.market = undefined; this.round = undefined; this.displayed = null; this.lastDisplayed = null; this.count = null;
    this.phase = 'waiting'; this.behind = false; this.unavailable = false; this.automatic = undefined;
    this.nextDiscover = 0; this.nextProgress = 0;
  }

  private discover(): void {
    const stream = this.stream, generation = this.generation;
    if (!stream || (this.discoverSub && !this.discoverSub.closed)) return;
    this.nextDiscover = this.now+4000;
    this.discoverSub = forkJoin({ markets: this.api.listPublicMarkets(stream.id), health: this.api.health() }).pipe(timeout(8000)).subscribe({
      next: ({ markets, health }) => {
        if (generation !== this.generation) return;
        this.automatic = health.automaticSettlement === true;
        if (!this.automatic) { this.player?.releaseAnalysisSync(); this.count = null; return; }
        const ended = this.round && (this.round.status === 'void' || this.phase === 'result');
        const next = pickObservedMarket(markets, stream.id, this.now, stream.countingGuide?.sourceFingerprint);
        const stale = !this.round?.live || this.now-Date.parse(this.round.live.updatedAt)>15_000;
        const newerStarted = this.market && next && Date.parse(next.windowStart)>Date.parse(this.market.windowStart) && Date.parse(next.windowStart)<=this.now;
        const stalled = newerStarted && stale && this.now>Date.parse(this.market!.windowEnd)+30_000;
        // Finish the displayed window, but do not strand viewers on a failed previous round.
        if (this.market && !ended && !stalled && this.now <= Date.parse(this.market.windowEnd)+90_000) return;
        if (!next) {
          if (!this.market || this.now > Date.parse(this.market.windowEnd)+90_000) {
            this.player?.releaseAnalysisSync(); this.market = undefined; this.round = undefined; this.count = null; this.displayed = null; this.lastDisplayed = null;
          }
          return;
        }
        if (next.id === this.market?.id) return;
        if (this.market) this.player?.releaseAnalysisSync();
        this.liveSub?.unsubscribe(); this.market = next; this.round = undefined; this.displayed = null; this.lastDisplayed = null;
        this.phase = Date.parse(next.windowStart)>this.now ? 'waiting' : 'syncing';
        this.count = Date.parse(next.windowStart)>this.now ? 0 : null; this.unavailable = false; this.nextProgress = 0;
      },
      error: () => { if (generation === this.generation) this.unavailable = true; }
    });
  }

  private progress(): void {
    const market = this.market, generation = this.generation;
    if (!market || this.automatic !== true || (this.liveSub && !this.liveSub.closed)) return;
    this.nextProgress = this.now+1000;
    this.liveSub = this.api.liveRound(market.id).pipe(timeout(8000)).subscribe({
      next: round => {
        if (generation !== this.generation || this.market?.id !== round.marketId || round.streamId !== this.stream?.id) return;
        this.round = round; this.unavailable = false;
      },
      error: () => { if (generation === this.generation && this.market?.id === market.id) this.unavailable = true; }
    });
  }

  private tick(): void {
    if (!this.identity) return;
    this.now = Date.now();
    if (this.now >= this.nextDiscover && !document.hidden) this.discover();
    if (this.automatic === false) return;
    if (this.now >= this.nextProgress && !document.hidden) this.progress();
    if (!this.round) return;
    if (!this.unavailable) this.player?.syncToAnalysis(this.round);
    const segments = this.round.live?.segments;
    this.displayed = segments?.length ? this.player?.displayedCaptureTime(segments) ?? null : null;
    // HLS seeks can temporarily remove the frame clock. Keep this window and
    // its last shown count until mapping resumes; never reveal a future count.
    if (this.displayed !== null) this.lastDisplayed = this.displayed;
    const shown = this.displayed ?? this.lastDisplayed;
    this.phase = livePhase(this.round, shown, this.now);
    this.behind = aiBehind(this.round, shown, this.now, this.phase);
    this.count = this.round.status === 'void' ? null : this.phase === 'result' && this.round.status === 'settled'
      ? this.round.actualCount ?? null : this.round.live ? liveCount(this.round, shown) : this.phase === 'waiting' ? 0 : null;
    if (this.round.status === 'open' && this.round.live && this.phase !== 'waiting' && this.now-Date.parse(this.round.live.updatedAt)>15_000) this.unavailable = true;
    if (this.unavailable) this.player?.releaseAnalysisSync();
  }
}
