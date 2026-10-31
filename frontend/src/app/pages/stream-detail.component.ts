import { DatePipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { Component, DestroyRef, OnDestroy, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription, distinctUntilChanged, forkJoin, map, timeout } from 'rxjs';
import { CountingRulesComponent } from '../components/counting-rules.component';
import { VideoPlayerComponent } from '../components/video-player.component';
import { BetSide, Market, StreamMetric, TrafficStream } from '../models';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { apiError } from '../services/ui-helpers';
import { acceptsPredictions, roundPhase, roundPhaseLabels } from '../services/round-state';

@Component({ selector: 'app-stream-detail', standalone: true, imports: [DatePipe, DecimalPipe, FormsModule, NgFor, NgIf, RouterLink, VideoPlayerComponent, CountingRulesComponent], template: `
  <div class="camera-detail-links"><a class="back-link" routerLink="/">← All cameras</a><a class="text-button" routerLink="/how-it-works">How it works ↗</a></div>
  <div class="loading-state" *ngIf="loading" role="status"><span class="spinner"></span> Loading camera…</div>
  <div *ngIf="error" class="state-panel error-state" role="alert"><h3>Camera unavailable</h3><p>{{ error }}</p><button class="button" type="button" (click)="load()">Try again</button></div>
  <section class="camera-detail-page" *ngIf="stream && !loading && !error">
    <p class="notice" *ngIf="refreshError" role="status">{{ refreshError }} <button class="text-button" type="button" (click)="load(true)" [disabled]="refreshing">Retry update</button></p>
    <div class="page-heading"><div><span class="eyebrow">{{ stream.city }} / {{ stream.country }}</span><h1>{{ stream.title }}<span class="heading-dot">.</span></h1><p>{{ stream.locationLabel }}</p></div><span class="status-pill"><span class="dot"></span> Camera source</span></div>
    <div class="detail-layout">
      <div class="watch-column"><app-video-player [stream]="stream" [countingSnapshot]="displayedRound?.countingRules"></app-video-player></div>
      <section class="prediction-column" aria-labelledby="camera-rounds-heading">
        <div class="panel prediction-panel">
          <div class="prediction-intro"><div><div class="eyebrow"><span class="dot orange"></span> PREDICT WITH VIRTUAL CREDITS</div><h2 id="camera-rounds-heading">Choose a round. Predict the traffic.</h2><p class="small-note">Will the vehicle count finish over the threshold, or under or equal to it?</p></div><div class="prediction-balance" *ngIf="auth.user"><span>Your available balance</span><strong>{{ auth.user.balanceCredits | number:'1.0-0' }} <small>cr</small></strong></div><span class="tag neutral" *ngIf="!auth.user">Virtual credits only</span></div>
          <ol class="prediction-steps" aria-label="How to place a prediction"><li><span>1</span><div><strong>Choose the interval</strong><small>Check the counting time, threshold and rules.</small></div></li><li><span>2</span><div><strong>Enter a virtual stake</strong><small>Use credits from your demo balance.</small></div></li><li><span>3</span><div><strong>Place your prediction</strong><small>Press Place Over or Place Under or equal.</small></div></li></ol>
          <div class="round-update-row"><p class="small-note" *ngIf="lastUpdated">Updated {{ lastUpdated | date:'HH:mm:ss' }} · refreshes every 5 seconds.</p><button class="text-button" type="button" (click)="load(true)" [disabled]="refreshing">{{ refreshing ? 'Updating…' : 'Refresh rounds' }}</button></div>
          <p class="success message" *ngIf="message" role="status">{{ message }}</p><p class="error message" *ngIf="betError" role="alert">{{ betError }}</p>
          <p class="notice selected-round-unavailable" *ngIf="requestedRoundUnavailable" role="status">The selected round is no longer available for predictions. Choose an open round below.</p>
          <div class="prediction-round-grid">
            <article class="prediction-market" *ngFor="let market of activeMarkets; trackBy: trackMarket" [attr.id]="'round-' + market.id" [class.selected-market]="isSelectedMarket(market)" tabindex="-1">
              <div class="market-meta"><span class="tag" [class.closed-tag]="!acceptsBets(market)">{{ phaseLabels[phase(market)] }}</span><span>Round #{{ market.id }}</span></div>
              <h3>{{ market.title }}</h3><app-counting-rules [snapshot]="market.countingRules"></app-counting-rules>
              <div class="market-threshold"><strong>{{ market.threshold }}</strong><span>vehicles<br>prediction threshold</span></div>
              <div class="market-times"><span>Prediction deadline<strong>{{ market.bettingClosesAt | date:'MMM d, HH:mm:ss' }}</strong></span><span>Counting interval<strong>{{ market.windowStart | date:'HH:mm:ss' }} — {{ market.windowEnd | date:'HH:mm:ss' }}</strong></span></div>
              <p class="small-note">Over: &gt; {{ market.threshold }}. Under or equal: ≤ {{ market.threshold }}. Times are local.</p>
              <ng-container *ngIf="acceptsBets(market)">
                <p class="selected-round-note" *ngIf="isSelectedMarket(market)" [attr.id]="'round-selection-' + market.id" role="status"><strong>{{ selectedSide ? (selectedSide === 'over' ? 'Selected: Over' : 'Selected: Under or equal') : 'Selected round' }}</strong> Review your stake, then press Place to confirm. Nothing has been placed yet.</p>
                <div class="round-stake-area"><label class="stake-field">Your stake · virtual credits<input type="number" min="1" [max]="auth.user?.balanceCredits ?? 100000" step="1" [name]="'stake-' + market.id" [(ngModel)]="stakes[market.id]" [disabled]="!auth.user || !acceptsBets(market) || submitting"></label>
                <div class="choice-row"><button class="outcome-button" type="button" [class.selected-outcome]="isSelectedMarket(market) && selectedSide === 'over'" [attr.aria-describedby]="isSelectedMarket(market) ? 'round-selection-' + market.id : null" (click)="placeBet(market, 'over')" [disabled]="!auth.user || !acceptsBets(market) || submitting"><span>Place Over</span><strong>{{ market.oddsOver | number:'1.2-2' }}×</strong></button><button class="outcome-button under" type="button" [class.selected-outcome]="isSelectedMarket(market) && selectedSide === 'under'" [attr.aria-describedby]="isSelectedMarket(market) ? 'round-selection-' + market.id : null" (click)="placeBet(market, 'under')" [disabled]="!auth.user || !acceptsBets(market) || submitting"><span>Place Under or equal</span><strong>{{ market.oddsUnder | number:'1.2-2' }}×</strong></button></div>
                <p class="small-note place-action-note" *ngIf="auth.user">Pressing either Place button spends the entered virtual stake.</p></div>
              </ng-container>
              <p class="small-note round-phase-note" *ngIf="!acceptsBets(market)">{{ phaseDescription(market) }}</p>
            </article>
          </div>
          <div class="empty-note" *ngIf="!activeMarkets.length">No current or upcoming rounds. Check back for the next counting interval. Your past predictions remain in My predictions.</div>
          <a *ngIf="!auth.user" class="button primary sign-in-prediction" routerLink="/login" [queryParams]="{ returnUrl: '/streams/' + stream.id }">Sign in to predict →</a>
          <details class="prediction-deadlines"><summary>Deadlines, camera movement &amp; refunds</summary><p class="small-note">Predictions close at least 30 seconds before counting starts. Playback delays do not extend the deadline. An operator verifies each result. The source operator may pan, tilt or zoom the camera. If movement changes or hides the counting zone during a round, that round must be voided and its stakes refunded.</p></details>
          <p class="credits-note">Virtual credits only. No monetary transactions.</p>
        </div>
        <div class="ai-note"><span>◉</span><div><strong>Verified results</strong><p>Counts are currently verified by an operator. Any future AI counts will be clearly labelled.</p></div></div>
      </section>
      <div class="camera-information-grid">
        <div class="panel about-camera"><div><span class="eyebrow">ABOUT THIS LOCATION</span><h2>Behind the camera</h2></div><p>{{ stream.description || 'No description has been added for this camera yet.' }}</p><div class="source-row"><span>Source operator</span><strong>{{ stream.sourceOwner || 'Not specified' }}</strong></div><div class="source-row" *ngIf="safeSourceLink(stream.sourcePageUrl)"><span>Source website</span><a [href]="safeSourceLink(stream.sourcePageUrl)" target="_blank" rel="noopener noreferrer" class="text-button">Visit source ↗</a></div><div class="source-row" *ngIf="safeSourceLink(stream.termsUrl)"><span>Licence and terms</span><a [href]="safeSourceLink(stream.termsUrl)" target="_blank" rel="noopener noreferrer" class="text-button">Read source licence ↗</a></div><p *ngIf="stream.sourceOwner === &quot;Transport for London&quot;" class="source-attribution"><a href="https://tfl.gov.uk/info-for/open-data-users/our-open-data" target="_blank" rel="noopener noreferrer">Powered by TfL Open Data ↗</a></p><p class="small-note" *ngIf="stream.usageNotes">{{ stream.usageNotes }}</p></div>
        <div class="panel metrics-panel"><div class="section-toolbar"><div><span class="eyebrow">COUNT HISTORY</span><h2>Vehicles per interval</h2></div><span class="tag">{{ metrics.length }} records</span></div><p class="muted small-note">Each bar represents one completed counting interval. Interval lengths may differ.</p><div class="metric-chart" *ngIf="metrics.length" aria-label="Vehicle counts for recent intervals"><div class="chart-column" *ngFor="let metric of chartMetrics"><strong>{{ metric.vehicleCount }}</strong><div class="chart-bar" [style.height.%]="barHeight(metric)" [class.ai-bar]="metric.source === 'ai'"></div><small>{{ metric.intervalEnd | date:'HH:mm:ss' }}</small></div></div><div class="metric-list"><div class="metric-row" *ngFor="let metric of metrics.slice(0, 6)"><div><strong>{{ metric.vehicleCount }} vehicles</strong><small>{{ metric.intervalStart | date:'MMM d, HH:mm:ss' }} — {{ metric.intervalEnd | date:'HH:mm:ss' }}</small></div><span [class]="'metric-source ' + metric.source">{{ metric.source === 'ai' ? '✳ AI' : '◉ Operator' }}</span></div></div><p class="empty-note" *ngIf="!metrics.length">No verified counts yet. Completed rounds will appear here after verification.</p></div>
      </div>
    </div>
  </section>
`, styles: [`
  :host{display:block;min-width:0}.camera-detail-page .detail-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;align-items:start}.camera-detail-page .watch-column{min-width:0;display:block}.camera-detail-page .prediction-column{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;min-width:0}.camera-detail-page .prediction-panel{padding:26px;background:var(--surface)}.prediction-intro{display:flex;align-items:flex-start;justify-content:space-between;gap:22px;flex-wrap:wrap}.prediction-intro>div:first-child{min-width:0;flex:1 1 320px}.camera-detail-page .prediction-panel h2{font-size:28px;line-height:1.25;margin:12px 0}.prediction-intro .small-note{margin:0;font-size:12px;line-height:1.75}.prediction-balance{padding:15px 18px;display:grid;gap:8px;background:var(--bg);border:1px solid var(--line);border-radius:9px;min-width:170px}.prediction-balance>span{font-size:11px;color:var(--muted)}.prediction-balance>strong{font-size:25px;font-variant-numeric:tabular-nums;line-height:1.2}.prediction-balance small{font-size:13px;font-weight:500;color:var(--muted)}.prediction-steps{list-style:none;padding:20px 0;margin:21px 0 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}.prediction-steps li{display:flex;align-items:flex-start;gap:11px;min-width:0}.prediction-steps li>span{display:grid;place-items:center;flex:0 0 26px;height:26px;border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:50%;font-size:11px;font-weight:700}.prediction-steps li>div{display:grid;gap:6px}.prediction-steps strong{font-size:12px;line-height:1.5}.prediction-steps small{font-size:11px;line-height:1.6;color:var(--muted)}.round-update-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:12px 0 17px}.round-update-row .small-note{margin:0;font-size:11px}.round-update-row .text-button{font-size:12px}.prediction-round-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:18px;align-items:stretch}.camera-detail-page .prediction-market{min-width:0;border:1px solid var(--line);padding:20px;margin:0;border-radius:11px;background:var(--surface);display:flex;flex-direction:column;scroll-margin-top:24px}.camera-detail-page .prediction-market.selected-market{border:2px solid var(--orange);padding:19px}.camera-detail-page .prediction-market h3{font-size:18px;line-height:1.5;margin:15px 0 10px;overflow-wrap:anywhere}.camera-detail-page .market-meta{font-size:11px}.camera-detail-page .market-meta .tag{font-size:10px}.camera-detail-page .market-threshold{padding:15px 18px;margin:16px 0 0;background:var(--bg);border-color:var(--line)}.camera-detail-page .market-threshold>strong{color:var(--ink);font-size:37px}.camera-detail-page .market-threshold>span{font-size:11px;color:var(--muted);line-height:1.6}.camera-detail-page .market-times{font-size:11px;line-height:1.6;gap:10px;margin:17px 0 12px}.camera-detail-page .market-times>span{flex-wrap:wrap;gap:3px 12px}.camera-detail-page .market-times strong{font-size:12px}.camera-detail-page .prediction-market>.small-note{font-size:11px;line-height:1.75}.round-stake-area{margin-top:auto}.camera-detail-page .stake-field{font-size:11px;margin:10px 0 12px}.camera-detail-page .stake-field input{font-size:15px;font-variant-numeric:tabular-nums}.camera-detail-page .choice-row{gap:10px}.camera-detail-page .outcome-button{min-height:75px;flex-direction:column;align-items:flex-start;justify-content:space-between;gap:8px;padding:12px;font-size:12px;text-align:left;line-height:1.5}.camera-detail-page .outcome-button strong{font-size:14px}.camera-detail-page .place-action-note{margin:10px 0 0;font-size:10px;line-height:1.7}.camera-detail-page .round-phase-note{margin-top:auto;padding-top:10px}.sign-in-prediction{margin-top:20px}.prediction-deadlines{margin-top:22px;padding-top:17px;border-top:1px solid var(--line)}.prediction-deadlines>summary,.recent-rounds>summary{font-size:12px;font-weight:650;line-height:1.7;cursor:pointer}.prediction-deadlines p{margin:12px 0 0;font-size:12px;line-height:1.8}.camera-detail-page .credits-note{font-size:11px;margin-top:18px}.recent-rounds>summary{font-size:16px}.recent-rounds>summary>span{font-size:11px;font-weight:500;margin-left:9px;color:var(--muted)}.recent-rounds .prediction-round-grid{margin-top:20px}.camera-detail-page .ai-note strong{font-size:12px}.camera-detail-page .ai-note p{font-size:11px;margin-top:5px}.camera-information-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;align-items:start}.camera-detail-page .about-camera>p{font-size:12px;line-height:1.8}.camera-detail-page .source-row{font-size:11px;flex-wrap:wrap}.camera-detail-page .source-row strong{overflow-wrap:anywhere}.camera-detail-page .source-row .text-button{font-size:12px}.camera-detail-page .metrics-panel .small-note{font-size:11px;line-height:1.8}@media(max-width:1000px){.prediction-steps{gap:15px}.prediction-steps li{gap:9px}.camera-information-grid{grid-template-columns:minmax(0,1fr)}}@media(max-width:650px){.camera-detail-page .detail-layout{gap:20px}.camera-detail-page .prediction-panel{padding:21px 17px}.camera-detail-page .prediction-panel h2{font-size:24px}.prediction-intro{gap:16px}.prediction-intro>div:first-child{flex-basis:100%}.prediction-balance{display:flex;align-items:center;justify-content:space-between;min-width:0;width:100%;padding:12px 14px}.prediction-balance>strong{font-size:23px}.prediction-steps{grid-template-columns:1fr;gap:15px;margin-top:19px;padding:18px 0}.prediction-round-grid{grid-template-columns:minmax(0,1fr);gap:15px}.camera-detail-page .prediction-market{padding:17px}.camera-detail-page .prediction-market.selected-market{padding:16px}.round-update-row{align-items:flex-start;gap:6px}.camera-detail-page .choice-row{gap:9px}.camera-detail-page .outcome-button{font-size:11px;padding:11px}.camera-information-grid{gap:20px}}
`] })
export class StreamDetailComponent implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  readonly phaseLabels = roundPhaseLabels;
  stream?: TrafficStream; markets: Market[] = []; metrics: StreamMetric[] = []; stakes: Record<number, number> = {};
  loading = true; refreshing = false; error = ''; refreshError = ''; betError = ''; message = ''; submitting = false;
  now = Date.now(); lastUpdated?: Date;
  private streamId = 0; private timer?: number; private refreshTimer?: number; private request?: Subscription;
  private intent?: { fingerprint: string; key: string };
  private anchorFrame?: number; private anchorGeneration = 0; private initialAnchorHandled = false; private destroyed = false;

  // URL choices only guide the form. They never create a prediction or alter its stake.
  get requestedRoundId(): number | undefined {
    const values = this.route.snapshot?.queryParamMap?.getAll('round') ?? [];
    if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) return undefined;
    const id = Number(values[0]);
    return Number.isSafeInteger(id) ? id : undefined;
  }
  get selectedSide(): BetSide | undefined {
    const values = this.route.snapshot?.queryParamMap?.getAll('side') ?? [];
    return this.selectedMarket && values.length === 1 && (values[0] === 'over' || values[0] === 'under') ? values[0] : undefined;
  }
  get selectedMarket(): Market | undefined {
    const id = this.requestedRoundId;
    return id === undefined ? undefined : this.markets.find((market) => market.id === id && market.streamId === this.stream?.id && this.acceptsBets(market));
  }
  get displayedRound(): Market | undefined {
    return this.selectedMarket ?? this.activeMarkets.find(market => this.phase(market) === 'counting') ?? this.activeMarkets.find(market => this.phase(market) === 'locked') ?? this.activeMarkets.find(market => this.acceptsBets(market));
  }
  get requestedRoundUnavailable(): boolean { return this.requestedRoundId !== undefined && !this.loading && !this.selectedMarket; }
  isSelectedMarket(market: Market): boolean { return this.selectedMarket?.id === market.id; }

  safeSourceLink(raw: string): string { try { const url = new URL(raw); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; } }
  get chartMetrics(): StreamMetric[] { return this.metrics.slice(0, 7).reverse(); }
  get activeMarkets(): Market[] { return this.markets.filter((market) => ['open', 'locked', 'counting'].includes(this.phase(market))).sort((a, b) => Date.parse(a.windowStart) - Date.parse(b.windowStart)); }
  barHeight(metric: StreamMetric): number { return Math.max(3, metric.vehicleCount / Math.max(1, ...this.chartMetrics.map((item) => item.vehicleCount)) * 100); }
  trackMarket(_index: number, market: Market): number { return market.id; }
  phase(market: Market) { return roundPhase(market, this.now); }
  acceptsBets(market: Market): boolean { return acceptsPredictions(market, this.now, this.stream); }
  phaseDescription(market: Market): string {
    switch (this.phase(market)) {
      case 'locked': return 'Predictions are locked. Counting has not started yet.';
      case 'counting': return 'Counting is in progress. New predictions are no longer accepted.';
      case 'verifying': return 'The counting window has ended. An operator must verify the result before credits are settled.';
      default: return 'This round is unavailable for predictions.';
    }
  }
  ngOnInit(): void {
    this.route.paramMap.pipe(map((params) => Number(params.get('id'))), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef)).subscribe((id) => {
      this.cancelRoundAnchor(); this.initialAnchorHandled = false;
      this.streamId = id; this.stream = undefined; this.markets = []; this.metrics = []; this.stakes = {};
      this.betError = ''; this.message = ''; this.intent = undefined; this.lastUpdated = undefined;
      this.load();
    });
    this.timer = window.setInterval(() => this.now = Date.now(), 1000);
    this.refreshTimer = window.setInterval(() => { if (!document.hidden && !this.loading && !this.refreshing && !this.submitting && this.stream) this.load(true); }, 5000);
  }
  ngOnDestroy(): void {
    this.destroyed = true; this.cancelRoundAnchor();
    if (this.timer) window.clearInterval(this.timer);
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
  }
  load(background = false): void {
    this.request?.unsubscribe();
    this.refreshing = background; this.loading = !background; this.error = ''; this.refreshError = '';
    if (!Number.isSafeInteger(this.streamId) || this.streamId < 1) { this.loading = false; this.refreshing = false; this.error = 'This camera address is invalid.'; return; }
    this.request = forkJoin({ stream: this.api.getStream(this.streamId), markets: this.api.listPublicMarkets(this.streamId, 'open'), metrics: this.api.listMetrics(this.streamId) })
      .pipe(timeout(10_000), takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (data) => {
          // Keep the existing player alive when only counts or round statuses change.
          if (JSON.stringify(this.stream) !== JSON.stringify(data.stream)) this.stream = data.stream;
          this.markets = data.markets.filter((market) => market.status === 'open'); this.metrics = data.metrics;
          this.markets.forEach((market) => this.stakes[market.id] ??= 25);
          this.now = Date.now(); this.lastUpdated = new Date(); this.loading = false; this.refreshing = false;
          if (!background) this.followInitialRoundAnchor();
        },
        error: (error) => {
          this.loading = false; this.refreshing = false;
          if (background && error.status === 404) { this.stream = undefined; this.markets = []; this.error = 'This camera has been disabled or is no longer available.'; }
          else if (background) this.refreshError = 'Round updates are unavailable. The information below may be out of date.';
          else this.error = apiError(error, 'This camera was not found or is unavailable.');
        }
      });
  }
  private cancelRoundAnchor(): void {
    this.anchorGeneration++;
    if (this.anchorFrame !== undefined && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(this.anchorFrame);
    this.anchorFrame = undefined;
  }
  private followInitialRoundAnchor(): void {
    if (this.initialAnchorHandled) return;
    this.initialAnchorHandled = true;
    const market = this.selectedMarket;
    if (!market || typeof window === 'undefined' || typeof document === 'undefined' || typeof window.requestAnimationFrame !== 'function' || typeof document.getElementById !== 'function') return;
    const generation = this.anchorGeneration, streamId = this.streamId, marketId = market.id;
    let attempts = 0;
    const follow = () => {
      if (this.destroyed || generation !== this.anchorGeneration || streamId !== this.streamId || this.selectedMarket?.id !== marketId) return;
      this.anchorFrame = undefined;
      // Only our validated round identifier is used. Arbitrary URL fragments are ignored.
      const card = document.getElementById(`round-${marketId}`);
      if (card) {
        card.scrollIntoView({ block: 'start', behavior: 'auto' });
        card.focus({ preventScroll: true });
      } else if (++attempts < 3) this.anchorFrame = window.requestAnimationFrame(follow);
    };
    this.anchorFrame = window.requestAnimationFrame(follow);
  }
  placeBet(market: Market, side: BetSide): void {
    this.betError = ''; this.message = ''; this.now = Date.now();
    const stake = Number(this.stakes[market.id]), userId = this.auth.user?.id, sessionGeneration = this.auth.sessionGeneration, streamId = this.streamId;
    if (userId === undefined || !this.auth.user || !this.acceptsBets(market) || this.submitting) return;
    if (!Number.isInteger(stake) || stake < 1 || stake > 100000 || stake > this.auth.user.balanceCredits) { this.betError = 'Enter a whole-number stake from 1 cr up to your available balance (maximum 100,000 cr).'; return; }
    this.submitting = true;
    const fingerprint = JSON.stringify([userId, market.id, side, stake]);
    if (this.intent?.fingerprint !== fingerprint) this.intent = { fingerprint, key: crypto.randomUUID() };
    this.api.createBet(market.id, side, stake, this.intent.key).pipe(timeout(15_000)).subscribe({
      next: ({ user }) => {
        if (this.auth.user?.id === userId && this.auth.sessionGeneration === sessionGeneration) this.auth.updateUser(user);
        this.submitting = false;
        if (this.streamId !== streamId) return;
        this.intent = undefined; this.message = `Prediction placed: ${stake} cr. The result will appear in your history.`;
      },
      error: (error) => {
        this.submitting = false;
        if (this.streamId !== streamId) return;
        if (error.status > 0 && error.status < 500) this.intent = undefined;
        this.betError = apiError(error);
        if (error.status === 409) this.load(true);
      }
    });
  }
}
