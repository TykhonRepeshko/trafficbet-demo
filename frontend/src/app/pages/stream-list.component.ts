import { DatePipe, NgFor, NgIf } from '@angular/common';
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
  imports: [DatePipe, NgFor, NgIf, FormsModule, RouterLink, CameraSceneComponent, CountingOverlayComponent],
  template: `
    <section class="camera-home prediction-home">
      <header class="home-intro home-intro-compact">
        <div class="home-intro-copy">
          <div class="eyebrow"><span class="tiny-line"></span> TRAFFIC PREDICTIONS · VIRTUAL CREDITS</div>
          <h1>Choose a camera.<br><span>Make your prediction.</span></h1>
          <p>Enter a vehicle-count range, choose your virtual stake and review everything before placing.</p>
        </div>
        <ol class="home-journey" aria-label="How to make a prediction"><li><span>1</span><div><strong>Open a camera</strong><small>Choose an open prediction round, including the next one.</small></div></li><li><span>2</span><div><strong>Enter your range</strong><small>For example, from 12 to 25 vehicles.</small></div></li><li><span>3</span><div><strong>Review &amp; confirm</strong><small>Check the counting time, choose credits and confirm.</small></div></li></ol>
      </header>
      <details class="home-quick-help"><summary>First time here? See a prediction example</summary><div class="home-quick-help-content"><div><strong>From 12 to 25 vehicles</strong><p>A verified count of 12, 18 or 25 wins. A count of 11 or 26 loses. Both bounds are included.</p><p>Credits are spent only after you confirm on the camera page. This example does not place a prediction.</p></div><div><strong>Over / Under is also available</strong><div class="demo-choices"><button class="demo-choice" type="button" [class.is-active]="exampleSide === 'over'" [attr.aria-pressed]="exampleSide === 'over'" (click)="chooseExample('over')"><span>Threshold: 12 · Over</span><strong>13+ vehicles</strong></button><button class="demo-choice under" type="button" [class.is-active]="exampleSide === 'under'" [attr.aria-pressed]="exampleSide === 'under'" (click)="chooseExample('under')"><span>Threshold: 12 · Under or equal</span><strong>0–12 vehicles</strong></button></div><p role="status">{{ exampleExplanation }}</p></div><a class="text-button" routerLink="/how-it-works">Read the full rules →</a></div></details>

      <div class="camera-lobby-toolbar" id="prediction-rounds">
        <div class="camera-availability" role="group" aria-label="Filter cameras by entry availability"><button type="button" [attr.aria-pressed]="availability === 'all'" (click)="availability = 'all'">All cameras <span>{{ loading || error ? '—' : streams.length }}</span></button><button type="button" [attr.aria-pressed]="availability === 'open'" (click)="availability = 'open'">Entries open <span>{{ openCameraCountLabel }}</span></button></div>
        <button class="button compact lobby-refresh" type="button" (click)="error ? load() : refreshRounds()" [disabled]="loading || roundsRefreshing">{{ roundsRefreshing ? 'Updating…' : 'Refresh' }}</button>
      </div>
      <section class="home-directory" id="camera-directory" aria-labelledby="camera-directory-title">
        <div class="home-section-heading"><div><h2 id="camera-directory-title">{{ availability === 'open' ? 'Open for predictions' : 'Camera views' }}</h2><p>When a round closes, you can predict the next published round. Check its counting time below; times are local.</p></div><span class="home-result-count" *ngIf="!loading && !error">{{ filtered.length }} {{ filtered.length === 1 ? 'camera' : 'cameras' }}</span></div>
        <p class="lobby-notice" *ngIf="!loading && !marketsLoading && !error && !hasRoundErrors && streams.length && availability === 'all' && !availableRounds.length">No entries are open right now. Open a camera to watch and prepare your next prediction. New rounds appear here automatically when published.</p><p class="lobby-notice" *ngIf="!loading && hasRoundErrors" role="alert">Some round information is unavailable. A missing update does not mean entries are closed. Refresh to try again.</p>
        <div class="home-filters"><label class="home-search"><span aria-hidden="true">⌕</span><input [(ngModel)]="search" name="search" type="search" placeholder="Search camera, road or city" aria-label="Search cameras"></label><label class="home-city-filter"><span class="sr-only">Filter by city</span><select [(ngModel)]="city" name="city"><option value="">All cities</option><option *ngFor="let value of cities" [value]="value">{{ value }}</option></select></label><button class="button compact" *ngIf="hasCameraFilters" type="button" (click)="clearFilters()">Clear filters</button></div>
        <div class="loading-state" *ngIf="loading" role="status"><span class="spinner"></span> Loading cameras…</div>
        <div class="state-panel error-state" *ngIf="error" role="alert"><span class="state-icon" aria-hidden="true">!</span><h3>The camera directory is unavailable</h3><p>{{ error }}</p><button class="button" type="button" (click)="load()">Try again</button></div>
        <div class="home-camera-grid" *ngIf="!loading && !error">
          <article class="home-camera-card" *ngFor="let stream of filtered; trackBy: trackCamera" [class.camera-entries-open]="!!nextRound(stream.id)">
            <div class="camera-card-heading">
              <div><p class="home-camera-location">{{ stream.city }} <span> / </span> {{ stream.country }}</p><a class="camera-title-link" [routerLink]="['/streams', stream.id]"><h3>{{ stream.title }}</h3></a></div>
              <span class="camera-state-badge" [class.entries-open]="!!nextRound(stream.id)" [class.state-unknown]="marketsLoading || marketErrors[stream.id]">{{ cameraStateLabel(stream.id) }}</span>
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
              <span class="home-round-status">{{ predictsNextRound(stream.id) ? 'Next round' : 'Open for predictions' }}</span>
              <div class="camera-entry-timer" [class.closing-soon]="entryClosesSoon(market)" role="group" aria-label="Prediction entry deadline">
                <span>Time left to predict</span><strong>{{ closesIn(market) }}</strong>
                <small>Entries close {{ market.bettingClosesAt | date:'HH:mm:ss' }} · local time</small>
              </div>
              <div class="camera-count-time"><span>Vehicle counting</span><strong>{{ market.windowStart | date:'HH:mm:ss' }} — {{ market.windowEnd | date:'HH:mm:ss' }}</strong><small>{{ market.windowStart | date:'MMM d' }} · {{ durationSeconds(market) }}-second count · local time</small></div>
              <a class="camera-card-action camera-prediction-link" [routerLink]="['/streams', stream.id]" [queryParams]="{ round: market.id }" [fragment]="'round-' + market.id">{{ predictsNextRound(stream.id) ? 'Predict next round' : 'Make a prediction' }} <span aria-hidden="true">→</span></a>
              <small class="camera-stake-note">{{ predictsNextRound(stream.id) ? 'Your prediction applies to the future counting time shown above.' : 'Choose a range and stake on the next screen.' }}</small>
            </div>
            <ng-template #noRound>
              <div class="home-camera-round home-camera-round-empty camera-round-panel">
                <div class="camera-round-state"><span class="camera-state-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7v5l3 2"></path></svg></span><div><strong>{{ marketsLoading ? 'Checking rounds…' : marketErrors[stream.id] ? 'Round information unavailable' : currentRound(stream.id) ? 'Round in progress' : 'No open round' }}</strong><p>{{ marketsLoading ? 'Looking for virtual-credit predictions.' : marketErrors[stream.id] ? 'Explore the camera while we reconnect.' : waitingLabel(stream.id) }}</p></div></div>
                <p class="camera-round-window" *ngIf="currentRound(stream.id) as current">Count: {{ current.windowStart | date:'MMM d, HH:mm:ss' }} — {{ current.windowEnd | date:'HH:mm:ss' }} · local time</p>
                <a class="camera-card-action camera-explore-link" [routerLink]="['/streams', stream.id]">Watch &amp; prepare <span aria-hidden="true">→</span></a>
              </div>
            </ng-template>
            <div class="home-camera-source camera-card-attribution"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z"></path><path d="M14 3v5h5M9 12h6M9 16h6"></path></svg><div>Source: <a *ngIf="sourcePage(stream); else plainSource" [href]="sourcePage(stream)" target="_blank" rel="noopener noreferrer">{{ stream.sourceOwner || 'Camera provider' }} <span aria-hidden="true">↗</span></a><ng-template #plainSource><span>{{ stream.sourceOwner || 'Camera provider' }}</span></ng-template></div></div>
          </article>
        </div>
        <div class="state-panel home-empty" *ngIf="!loading && !error && !filtered.length"><span class="state-icon" aria-hidden="true">⌕</span><h3>{{ streams.length ? (availability === 'open' ? (hasRoundErrors ? 'Some entries could not be checked' : 'No matching cameras have open entries') : 'No cameras match your search') : 'No cameras are available yet' }}</h3><p>{{ streams.length ? (availability === 'open' ? 'Show all cameras to watch and prepare, or keep this filter open for automatic updates.' : 'Try a different city or a shorter search.') : 'A continuous camera source must be connected before it appears in this directory.' }}</p><button *ngIf="streams.length" type="button" class="button" (click)="clearFilters()">Show all cameras</button></div>
      </section>

      <p class="home-bottom-note">Virtual credits only · no purchases or withdrawals. <a routerLink="/how-it-works">Counting rules, deadlines &amp; refunds →</a></p>
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
  availability: 'all' | 'open' = 'all';
  exampleSide?: BetSide;
  private now = Date.now();
  private clock?: ReturnType<typeof setInterval>;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private streamRequest?: Subscription;
  private marketRequest?: Subscription;
  private loadGeneration = 0;

  get cities(): string[] { return [...new Set(this.streams.map((stream) => stream.city))].sort((a, b) => a.localeCompare(b, 'en')); }
  get filtered(): TrafficStream[] {
    const search = this.search.trim().toLocaleLowerCase('en');
    const openCameras = new Set(this.streams.filter(stream => !!this.nextRound(stream.id)).map(stream => stream.id));
    return this.streams.filter(stream => (!this.city || stream.city === this.city)
      && `${stream.title} ${stream.city} ${stream.country} ${stream.locationLabel}`.toLocaleLowerCase('en').includes(search)
      && (this.availability === 'all' || openCameras.has(stream.id)))
      .sort((a,b) => Number(openCameras.has(b.id))-Number(openCameras.has(a.id)));
  }
  get hasCameraFilters(): boolean { return !!this.search || !!this.city || this.availability !== 'all'; }
  get openCameraCountLabel(): number | string { return this.loading || this.error || this.marketsLoading || this.hasRoundErrors ? '—' : this.streams.filter(stream => !!this.nextRound(stream.id)).length; }
  trackCamera(_index: number, stream: TrafficStream): number { return stream.id; }
  cameraStateLabel(streamId: number): string {
    if (this.marketsLoading) return 'Checking entries';
    if (this.marketErrors[streamId]) return 'Update unavailable';
    if (this.nextRound(streamId)) return this.predictsNextRound(streamId) ? 'Next round open' : 'Entries open';
    const current=this.currentRound(streamId);
    return current ? roundPhase(current,this.now)==='counting' ? 'Counting now' : 'Entries closed' : 'Waiting for a round';
  }
  entryClosesSoon(market: Market): boolean { const remaining=Date.parse(market.bettingClosesAt)-this.now; return Number.isFinite(remaining) && remaining>0 && remaining<=10000; }
  durationSeconds(market: Market): number { return Math.round((Date.parse(market.windowEnd)-Date.parse(market.windowStart))/1000); }
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
  clearFilters(): void { this.search = ''; this.city = ''; this.availability = 'all'; }
  nextRound(streamId: number): Market | undefined {
    if (this.marketErrors[streamId]) return undefined;
    return (this.markets[streamId] ?? []).filter(market => market.streamId === streamId && this.acceptingPredictions(market))
      .sort((a,b) => Date.parse(a.windowStart)-Date.parse(b.windowStart) || Date.parse(a.bettingClosesAt)-Date.parse(b.bettingClosesAt) || a.id-b.id)[0];
  }
  predictsNextRound(streamId: number): boolean {
    const target=this.nextRound(streamId);
    return !!target && (this.markets[streamId] ?? []).some(market => market.streamId === streamId
      && ['locked','counting'].includes(roundPhase(market,this.now)) && Date.parse(market.windowStart)<Date.parse(target.windowStart));
  }
  currentRound(streamId: number): Market | undefined {
    if (this.marketErrors[streamId]) return undefined;
    const rows = (this.markets[streamId] ?? []).filter(market => market.streamId === streamId)
      .sort((a,b) => Date.parse(a.windowStart)-Date.parse(b.windowStart) || a.id-b.id);
    return rows.find(market => roundPhase(market, this.now) === 'counting') ?? rows.find(market => roundPhase(market, this.now) === 'locked') ?? this.nextRound(streamId);
  }
  waitingLabel(streamId: number): string {
    const market = this.currentRound(streamId);
    if (!market) return 'Stake virtual credits when a round opens.';
    const counting = roundPhase(market, this.now) === 'counting';
    const remaining = Math.max(0, Math.ceil((Date.parse(counting ? market.windowEnd : market.windowStart) - this.now) / 1000));
    const countdown = `${Math.floor(remaining / 60).toString().padStart(2, '0')}:${(remaining % 60).toString().padStart(2, '0')}`;
    return counting ? `Counting ends in ${countdown}. Entries for this round have closed.` : `Counting starts in ${countdown}. Entries for this round have closed.`;
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
