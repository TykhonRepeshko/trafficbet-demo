import { DatePipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { Component, DestroyRef, OnDestroy, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription, catchError, forkJoin, of, timeout } from 'rxjs';
import { CountingOverlayComponent } from '../components/counting-overlay.component';
import { CameraSceneComponent } from '../components/camera-scene.component';
import { BetSide, Market, TrafficStream } from '../models';
import { environment } from '../../environments/environment';
import { cameraSnapshotUrl } from '../services/media-urls';
import { ApiService } from '../services/api.service';
import { apiError } from '../services/ui-helpers';
import { acceptsPredictions, roundPhase } from '../services/round-state';

@Component({
  selector: 'app-stream-list', standalone: true,
  imports: [DatePipe, DecimalPipe, NgFor, NgIf, FormsModule, RouterLink, CameraSceneComponent, CountingOverlayComponent],
  template: `
    <section class="camera-home prediction-home">
      <div class="home-intro">
        <div class="home-intro-copy">
          <div class="eyebrow"><span class="tiny-line"></span> TRAFFIC PREDICTIONS · VIRTUAL CREDITS</div>
          <h1>Predict traffic.<br><span>Play with credits.</span></h1>
          <p>Choose a round, stake virtual credits, and predict whether the vehicle count will finish Over or Under or equal.</p>
          <div class="home-intro-actions"><a class="button primary" href="#prediction-rounds">Find a round <span aria-hidden="true">↓</span></a><a class="home-how-link" routerLink="/how-it-works">How it works <span aria-hidden="true">↗</span></a></div>
          <div class="home-principles"><span>Virtual stakes and payouts</span><span>No purchases or cash withdrawals</span></div>
        </div>
        <aside class="prediction-demo" aria-labelledby="demo-title">
          <div class="demo-label"><span class="eyebrow">PRACTICE EXAMPLE</span><span class="demo-badge">No credits used</span></div>
          <h2 id="demo-title">More than 12 vehicles<br>in 30 seconds?</h2>
          <p class="demo-hint">Try choosing an outcome. This is an illustration, not an open round.</p>
          <div class="demo-choices"><button class="demo-choice" type="button" [class.is-active]="exampleSide === 'over'" [attr.aria-pressed]="exampleSide === 'over'" (click)="chooseExample('over')"><span>Over</span><strong>13+ vehicles</strong></button><button class="demo-choice under" type="button" [class.is-active]="exampleSide === 'under'" [attr.aria-pressed]="exampleSide === 'under'" (click)="chooseExample('under')"><span>Under or equal</span><strong>12 or fewer</strong></button></div>
          <div class="demo-credit-example"><div><span>Example stake</span><strong>100 cr</strong></div><span aria-hidden="true">→</span><div><span>Winning return</span><strong>180 cr</strong></div></div>
          <p class="demo-explanation" role="status">{{ exampleExplanation }} Example odds: 1.80. A winning return includes the stake; a losing prediction returns 0 cr.</p>
          <a class="demo-link" routerLink="/how-it-works">Learn about stakes and payouts <span aria-hidden="true">→</span></a>
        </aside>
      </div>

      <div class="home-summary" aria-label="Prediction summary"><div><strong>{{ roundCountLabel }}</strong><span>rounds accepting predictions</span></div><div><strong>{{ loading || error ? '—' : streams.length }}</strong><span>camera views</span></div><p><span aria-hidden="true">◷</span> Choose your stake before the deadline. Results are verified after counting.<a routerLink="/how-it-works">Read the rules <span aria-hidden="true">→</span></a></p></div>

      <section class="prediction-lobby" id="prediction-rounds" aria-labelledby="prediction-rounds-title">
        <div class="home-section-heading"><div><div class="eyebrow">PICK YOUR NEXT PREDICTION</div><h2 id="prediction-rounds-title">Available rounds</h2><p>Choose an outcome, then review your stake on the round page. Credits move only when you place a prediction.</p></div><button class="button compact lobby-refresh" type="button" (click)="error ? load() : refreshRounds()" [disabled]="loading || roundsRefreshing">{{ roundsRefreshing ? 'Updating…' : 'Refresh rounds' }}</button></div>
        <div class="loading-state" *ngIf="loading || marketsLoading" role="status"><span class="spinner"></span> Finding rounds…</div>
        <p class="lobby-notice" *ngIf="!loading && (error || hasRoundErrors)" role="alert">{{ error ? 'We could not load the camera and round data. Try refreshing.' : 'Some round information is unavailable. Only successfully loaded rounds are shown.' }}</p>
        <div class="prediction-round-grid" *ngIf="!loading && !marketsLoading && !error">
          <article class="prediction-round-card" *ngFor="let entry of availableRounds; trackBy: trackRound">
            <div class="round-card-top"><span class="round-entry-status">Predictions open</span><span class="round-countdown">Closes in {{ closesIn(entry.market) }}</span></div>
            <p class="round-card-location">{{ entry.stream.city }} · {{ entry.stream.title }}</p>
            <h3>More than {{ entry.market.threshold | number:'1.0-0' }} vehicles?</h3>
            <div class="round-card-preview"><a [routerLink]="['/streams', entry.stream.id]" [queryParams]="{ round: entry.market.id }" [fragment]="'round-' + entry.market.id" [attr.aria-label]="'Inspect camera and counting zone for round ' + entry.market.id"><img *ngIf="thumbnail(entry.stream) && !failedThumbnails[entry.stream.id] && !preview" [src]="thumbnail(entry.stream)" [alt]="'Reference view for ' + entry.stream.title" loading="lazy" (error)="failedThumbnails[entry.stream.id] = true"><app-camera-scene *ngIf="preview" [variant]="entry.stream.id"></app-camera-scene><app-counting-overlay *ngIf="!preview && thumbnail(entry.stream) && !failedThumbnails[entry.stream.id]" [guide]="entry.stream.countingGuide" [snapshot]="entry.market.countingRules" [compact]="true"></app-counting-overlay><span *ngIf="!preview && (!thumbnail(entry.stream) || failedThumbnails[entry.stream.id])">View counting zone ↗</span></a><div><p class="round-counting-window">Counting window<strong>{{ entry.market.windowStart | date:'MMM d, HH:mm:ss' }} — {{ entry.market.windowEnd | date:'HH:mm:ss' }}</strong></p><p>Local time · round #{{ entry.market.id }}</p><p>{{ preview ? 'Illustrated preview' : isReferenceImage(entry.stream) ? 'Reference still · ' + referenceDate(entry.stream) : 'Preview image' }}</p></div></div>
            <div class="round-outcomes"><a class="round-outcome" [routerLink]="['/streams', entry.stream.id]" [queryParams]="{ round: entry.market.id, side: 'over' }" [fragment]="'round-' + entry.market.id"><span>Choose Over ↗</span><strong>&gt; {{ entry.market.threshold | number:'1.0-0' }}</strong><small>{{ entry.market.oddsOver | number:'1.2-2' }} odds</small></a><a class="round-outcome under" [routerLink]="['/streams', entry.stream.id]" [queryParams]="{ round: entry.market.id, side: 'under' }" [fragment]="'round-' + entry.market.id"><span>Choose Under or equal ↘</span><strong>≤ {{ entry.market.threshold | number:'1.0-0' }}</strong><small>{{ entry.market.oddsUnder | number:'1.2-2' }} odds</small></a></div>
            <div class="round-card-footer"><p>Stake virtual credits · winning returns include your stake.</p><a [routerLink]="['/streams', entry.stream.id]" [queryParams]="{ round: entry.market.id }" [fragment]="'round-' + entry.market.id">Open round →</a></div>
          </article>
        </div>
        <div class="lobby-empty" *ngIf="!loading && !marketsLoading && !error && !hasRoundErrors && !availableRounds.length"><strong>No rounds are accepting predictions right now.</strong><p>New rounds appear here once their counting window and deadline are published. Use the practice example above to see how virtual credits work.</p><a href="#camera-directory">Inspect the camera views ↓</a></div>
      </section>

      <section class="home-directory" id="camera-directory" aria-labelledby="camera-directory-title">
        <div class="home-section-heading"><div><div class="eyebrow">THE VIEWS BEHIND THE ROUNDS</div><h2 id="camera-directory-title">Camera views</h2><p>Inspect the road and counting zone before staking your virtual credits.</p></div><span class="home-result-count" *ngIf="!loading && !error">{{ filtered.length }} {{ filtered.length === 1 ? 'camera' : 'cameras' }}</span></div>
        <div class="home-filters"><label class="home-search"><span aria-hidden="true">⌕</span><input [(ngModel)]="search" name="search" type="search" placeholder="Search a camera, street, or city" aria-label="Search cameras"></label><label class="home-city-filter"><span class="sr-only">Filter by city</span><select [(ngModel)]="city" name="city"><option value="">All cities</option><option *ngFor="let value of cities" [value]="value">{{ value }}</option></select></label><button class="button compact" *ngIf="search || city" type="button" (click)="clearFilters()">Clear filters</button></div>
        <div class="loading-state" *ngIf="loading" role="status"><span class="spinner"></span> Loading cameras…</div>
        <div class="state-panel error-state" *ngIf="error" role="alert"><span class="state-icon" aria-hidden="true">!</span><h3>The camera directory is unavailable</h3><p>{{ error }}</p><button class="button" type="button" (click)="load()">Try again</button></div>
        <div class="home-camera-grid" *ngIf="!loading && !error">
          <article class="home-camera-card" *ngFor="let stream of filtered">
            <div class="camera-card-heading">
              <div><p class="home-camera-location">{{ stream.city }} <span> / </span> {{ stream.country }}</p><a class="camera-title-link" [routerLink]="['/streams', stream.id]"><h3>{{ stream.title }}</h3></a></div>
              <span class="camera-card-id">CAM / {{ stream.id }}</span>
            </div>
            <a class="home-camera-image" [routerLink]="['/streams', stream.id]" [attr.aria-label]="'Open camera: ' + stream.title">
              <app-camera-scene *ngIf="preview" [variant]="stream.id"></app-camera-scene>
              <img *ngIf="!preview && thumbnail(stream) && !failedThumbnails[stream.id]" [src]="thumbnail(stream)" [alt]="(isReferenceImage(stream) ? 'Reference camera view: ' : 'Camera preview: ') + stream.title" loading="lazy" referrerpolicy="no-referrer" (load)="previewLoaded(stream.id, $event)" (error)="failedThumbnails[stream.id] = true">
              <div *ngIf="!preview && (!thumbnail(stream) || failedThumbnails[stream.id])" class="home-camera-placeholder"><span aria-hidden="true">▣</span><strong>{{ stream.title }}</strong><small>{{ failedThumbnails[stream.id] ? 'Preview temporarily unavailable' : 'Open the camera to watch' }}</small></div>
              <app-counting-overlay *ngIf="!preview && !failedThumbnails[stream.id] && thumbnail(stream)" [guide]="stream.countingGuide" [snapshot]="currentRound(stream.id)?.countingRules" [mediaWidth]="previewSizes[stream.id]?.width ?? 0" [mediaHeight]="previewSizes[stream.id]?.height ?? 0"></app-counting-overlay>
            </a>
            <div class="home-preview-caption"><span>{{ preview ? 'Illustrated preview' : failedThumbnails[stream.id] || !thumbnail(stream) ? 'Preview unavailable' : isReferenceImage(stream) ? 'Reference still · ' + referenceDate(stream) : 'Preview image' }}</span><span>{{ feedLabel(stream) }}</span></div>
            <div class="home-camera-content"><p>{{ stream.locationLabel }}</p></div>
            <div class="home-camera-round camera-round-panel" *ngIf="nextRound(stream.id) as market; else noRound">
              <div class="home-round-top"><span class="home-round-status"><span class="dot orange" aria-hidden="true"></span> Predictions open</span><span class="home-round-time">Closes in {{ closesIn(market) }}</span></div>
              <strong>More than {{ market.threshold | number:'1.0-0' }} vehicles?</strong>
              <div class="camera-card-odds"><span>Over <b>{{ market.oddsOver | number:'1.2-2' }} <small>odds</small></b></span><span>Under or equal <b>{{ market.oddsUnder | number:'1.2-2' }} <small>odds</small></b></span></div>
              <a class="camera-card-action camera-prediction-link" [routerLink]="['/streams', stream.id]" [queryParams]="{ round: market.id }" [fragment]="'round-' + market.id">Choose a prediction <span aria-hidden="true">→</span></a>
              <small class="camera-stake-note">Review your virtual stake before placing.</small>
            </div>
            <ng-template #noRound>
              <div class="home-camera-round home-camera-round-empty camera-round-panel">
                <div class="camera-round-state"><span class="camera-state-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7v5l3 2"></path></svg></span><div><strong>{{ marketsLoading ? 'Checking rounds…' : marketErrors[stream.id] ? 'Round information unavailable' : currentRound(stream.id) ? 'Round in progress' : 'No open round' }}</strong><p>{{ marketsLoading ? 'Looking for virtual-credit predictions.' : marketErrors[stream.id] ? 'Explore the camera while we reconnect.' : waitingLabel(stream.id) }}</p></div></div>
                <a class="camera-card-action camera-explore-link" [routerLink]="['/streams', stream.id]">Explore camera <span aria-hidden="true">→</span></a>
              </div>
            </ng-template>
            <div class="home-camera-source camera-card-attribution"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z"></path><path d="M14 3v5h5M9 12h6M9 16h6"></path></svg><div>Source: <a *ngIf="sourcePage(stream); else plainSource" [href]="sourcePage(stream)" target="_blank" rel="noopener noreferrer">{{ stream.sourceOwner || 'Camera provider' }} <span aria-hidden="true">↗</span></a><ng-template #plainSource><span>{{ stream.sourceOwner || 'Camera provider' }}</span></ng-template></div></div>
          </article>
        </div>
        <div class="state-panel home-empty" *ngIf="!loading && !error && !filtered.length"><span class="state-icon" aria-hidden="true">⌕</span><h3>{{ streams.length ? 'No cameras match your search' : 'No cameras are available yet' }}</h3><p>{{ streams.length ? 'Try a different city or a shorter search.' : 'A continuous camera source must be connected before it appears in this directory.' }}</p><button *ngIf="streams.length" type="button" class="button" (click)="clearFilters()">Show all cameras</button></div>
      </section>

      <section class="home-rule-invite" aria-labelledby="home-rules-title"><div><span class="eyebrow">BEFORE YOUR FIRST PREDICTION</span><h2 id="home-rules-title">Know the window. Know the rules.</h2><p>Deadlines, counting zones, results and refunds — all explained in one place.</p></div><a class="button" routerLink="/how-it-works">How it works <span aria-hidden="true">→</span></a></section>
    </section>
  `
})
export class StreamListComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);
  readonly preview = environment.preview;
  failedThumbnails: Record<number, boolean> = {};
  previewSizes: Record<number, { width: number; height: number }> = {};
  marketErrors: Record<number, boolean> = {};
  streams: TrafficStream[] = [];
  markets: Record<number, Market[]> = {};
  loading = true;
  marketsLoading = false;
  roundsRefreshing = false;
  error = '';
  search = '';
  city = '';
  exampleSide?: BetSide;
  private now = Date.now();
  private clock?: ReturnType<typeof setInterval>;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private streamRequest?: Subscription;
  private marketRequest?: Subscription;
  private loadGeneration = 0;

  get cities(): string[] { return [...new Set(this.streams.map((stream) => stream.city))].sort((a, b) => a.localeCompare(b, 'en')); }
  get filtered(): TrafficStream[] { const search = this.search.trim().toLocaleLowerCase('en'); return this.streams.filter((stream) => (!this.city || stream.city === this.city) && `${stream.title} ${stream.city} ${stream.country} ${stream.locationLabel}`.toLocaleLowerCase('en').includes(search)); }
  get availableRounds(): Array<{ stream: TrafficStream; market: Market }> {
    return this.streams.flatMap((stream) => (this.markets[stream.id] ?? [])
      .filter((market) => market.streamId === stream.id && this.acceptingPredictions(market))
      .map((market) => ({ stream, market })))
      .sort((a, b) => Date.parse(a.market.bettingClosesAt) - Date.parse(b.market.bettingClosesAt) || a.market.id - b.market.id);
  }
  get hasRoundErrors(): boolean { return Object.values(this.marketErrors).some(Boolean); }
  trackRound(_index: number, entry: { stream: TrafficStream; market: Market }): string { return `${entry.stream.id}:${entry.market.id}`; }
  get upcomingRoundCount(): number { return this.availableRounds.length; }
  get roundCountLabel(): string | number { return this.loading || this.error || this.marketsLoading || Object.values(this.marketErrors).some(Boolean) ? '—' : this.upcomingRoundCount; }
  get exampleExplanation(): string {
    return this.exampleSide === 'over' ? 'Over wins at 13 or more vehicles.' : this.exampleSide === 'under' ? 'Under or equal wins at 12 or fewer vehicles.' : 'Choose an outcome above to see which counts would win.';
  }
  chooseExample(side: BetSide): void { if (side === 'over' || side === 'under') this.exampleSide = side; }
  closesIn(market: Market): string {
    const remaining = Date.parse(market.bettingClosesAt) - this.now;
    if (!Number.isFinite(remaining) || remaining <= 0) return 'Closed';
    const seconds = Math.ceil(remaining / 1000), hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    return `${hours ? hours.toString().padStart(2, '0') + ':' : ''}${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
  }
  thumbnail(stream: TrafficStream): string { return (this.preferReference(stream) ? this.referenceImage(stream) : '') || cameraSnapshotUrl(stream) || this.referenceImage(stream); }
  isReferenceImage(stream: TrafficStream): boolean { return !!this.referenceImage(stream) && (this.preferReference(stream) || !cameraSnapshotUrl(stream)); }
  private preferReference(stream: TrafficStream): boolean { return stream.sourceOwner === 'California Department of Transportation (Caltrans)'; }
  referenceDate(stream: TrafficStream): string { return stream.sourceOwner === 'Norwegian Public Roads Administration (Statens vegvesen)' || this.preferReference(stream) ? 'Oct 24, 2026' : 'Oct 16, 2026'; }
  private referenceImage(stream: TrafficStream): string {
    const catalogs: Record<string, Record<string, string>> = {
      'Norwegian Public Roads Administration (Statens vegvesen)': { 'E18 · Fiskevollbukta': '/cameras/fiskevollbukta.png', 'E6 · Djupdalen': '/cameras/djupdalen.png', 'E6 · Vingnes': '/cameras/vingnes.png', 'E39 · Fjøsangerveien': '/cameras/fjosangerveien.png', 'E16 · Skaret': '/cameras/skaret.png' },
      'California Department of Transportation (Caltrans)': { 'I-80 · Bay Bridge Incline': '/cameras/bay-bridge-incline.png' },
      'Delaware Department of Transportation (DelDOT)': { 'DE 1 · Milford Neck Road': '/cameras/milford-neck.jpg', 'West Dover Connector': '/cameras/west-dover.jpg', 'DE 1 · Dover Toll Plaza': '/cameras/dover-toll.jpg' }
    };
    return catalogs[stream.sourceOwner]?.[stream.title] ?? '';
  }
  feedLabel(stream: TrafficStream): string { switch (stream.streamType) { case 'mp4': return 'Recorded clips'; case 'image': return 'Snapshots'; case 'rtsp': return 'RTSP source'; default: return 'Camera feed'; } }
  sourcePage(stream: TrafficStream): string { try { const url = new URL(stream.sourcePageUrl); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; } }
  clearFilters(): void { this.search = ''; this.city = ''; }
  nextRound(streamId: number): Market | undefined { return this.markets[streamId]?.find((market) => this.acceptingPredictions(market)); }
  currentRound(streamId: number): Market | undefined {
    const rows = (this.markets[streamId] ?? []).filter(market => market.status === 'open' && Date.parse(market.windowEnd) > this.now);
    return rows.find(market => roundPhase(market, this.now) === 'counting') ?? rows.find(market => roundPhase(market, this.now) === 'locked') ?? rows.find(market => this.acceptingPredictions(market));
  }
  waitingLabel(streamId: number): string {
    const market = this.currentRound(streamId);
    if (!market) return 'Stake virtual credits when a round opens.';
    const counting = roundPhase(market, this.now) === 'counting';
    const remaining = Math.max(0, Math.ceil((Date.parse(counting ? market.windowEnd : market.windowStart) - this.now) / 1000));
    const countdown = `${Math.floor(remaining / 60).toString().padStart(2, '0')}:${(remaining % 60).toString().padStart(2, '0')}`;
    return counting ? `Counting ends in ${countdown}. New predictions are locked.` : `Counting starts in ${countdown}. New predictions are locked.`;
  }
  previewLoaded(streamId: number, event: Event): void {
    const image = event.target as HTMLImageElement;
    this.previewSizes[streamId] = { width: image.naturalWidth, height: image.naturalHeight };
  }
  private acceptingPredictions(market: Market): boolean {
    const stream = this.streams.find((item) => item.id === market.streamId);
    return acceptsPredictions(market, this.now, stream);
  }
  ngOnInit(): void {
    this.load(); this.clock = setInterval(() => { this.now = Date.now(); }, 1000);
    this.refreshTimer = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) this.refreshRounds(); }, 5000);
  }
  ngOnDestroy(): void {
    this.loadGeneration++; this.streamRequest?.unsubscribe(); this.marketRequest?.unsubscribe();
    if (this.clock) clearInterval(this.clock);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }
  load(): void {
    const generation = ++this.loadGeneration;
    this.streamRequest?.unsubscribe(); this.marketRequest?.unsubscribe();
    this.loading = true; this.error = ''; this.markets = {}; this.marketErrors = {}; this.marketsLoading = false; this.roundsRefreshing = false;
    this.streamRequest = this.api.listStreams().pipe(timeout(10_000), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (streams) => {
        if (generation !== this.loadGeneration) return;
        this.streams = streams.filter((stream) => stream.isActive); this.loading = false;
        this.refreshRounds(false);
      },
      error: (error) => { if (generation !== this.loadGeneration) return; this.streams = []; this.loading = false; this.error = apiError(error); }
    });
  }
  refreshRounds(background = true): void {
    if (this.loading || this.error || this.roundsRefreshing || !this.streams.length) return;
    const generation = this.loadGeneration, streams = [...this.streams];
    this.roundsRefreshing = true; this.marketsLoading = !background;
    this.marketRequest = forkJoin(streams.map((stream) => this.api.listPublicMarkets(stream.id)
      .pipe(timeout(6000), catchError(() => of(null)))))
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe((results) => {
        if (generation !== this.loadGeneration) return;
        const markets: Record<number, Market[]> = {}, errors: Record<number, boolean> = {};
        results.forEach((rows, index) => {
          const id = streams[index].id;
          errors[id] = rows === null;
          markets[id] = (rows ?? []).filter((market) => market.streamId === id)
            .sort((a, b) => Date.parse(a.bettingClosesAt) - Date.parse(b.bettingClosesAt));
        });
        this.markets = markets; this.marketErrors = errors;
        this.marketsLoading = false; this.roundsRefreshing = false; this.now = Date.now();
      });
  }
}
