import { DatePipe, NgFor, NgIf } from '@angular/common';
import { Component, DestroyRef, OnDestroy, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription, catchError, forkJoin, of, timeout } from 'rxjs';
import { CountingOverlayComponent } from '../components/counting-overlay.component';
import { CameraSceneComponent } from '../components/camera-scene.component';
import { IconComponent } from '../components/icon.component';
import { BetSide, Market, TrafficStream } from '../models';
import { environment } from '../../environments/environment';
import { cameraSnapshotUrl } from '../services/media-urls';
import { ApiService } from '../services/api.service';
import { apiError } from '../services/ui-helpers';
import { acceptsPredictions, roundPhase, roundPhaseLabels } from '../services/round-state';

@Component({
  selector: 'app-stream-list', standalone: true,
  imports: [DatePipe, NgFor, NgIf, FormsModule, RouterLink, CameraSceneComponent, CountingOverlayComponent, IconComponent],
  styleUrl: './stream-list.component.css',
  template: `
    <section class="home">
      <header class="monitor-header">
        <div><p class="tb-kicker">Admin workspace</p><h1>Camera monitor</h1><p>Inspect the live view, counting window and next round for each camera.</p></div>
        <nav class="monitor-actions" aria-label="Camera administration"><a class="tb-btn" routerLink="/admin">Admin panel</a><a class="tb-btn" routerLink="/admin" [queryParams]="{ tab: 'cameras' }">Manage cameras</a><a class="tb-btn" routerLink="/admin/preparation">Counting &amp; source checks</a></nav>
      </header>
      <div class="monitor-stats" *ngIf="!loading && !error"><div><span>Active cameras</span><strong>{{ streams.length }}</strong></div><div><span>Accepting predictions</span><strong>{{ openCameraCountLabel }}</strong></div><div><span>Paused / update unavailable</span><strong>{{ attentionCount }}</strong></div></div>
      <section class="home-directory" id="camera-directory" aria-labelledby="camera-directory-title">
        <div class="home-toolbar" id="prediction-rounds">
          <h2 id="camera-directory-title">{{ availability === 'open' ? 'Accepting predictions' : 'Active cameras' }} <span class="tb-chip" *ngIf="!loading && !error">{{ filtered.length }}</span></h2>
          <div class="home-filters">
            <label class="home-search"><app-icon name="search" [size]="17"></app-icon><span class="sr-only">Search cameras</span><input class="tb-input" [(ngModel)]="search" name="search" type="search" placeholder="Search camera, road or city"></label>
            <label class="home-city"><span class="sr-only">Filter by city</span><select class="tb-select" [(ngModel)]="city" name="city"><option value="">All cities</option><option *ngFor="let value of cities" [value]="value">{{ value }}</option></select></label>
            <div class="tb-seg" role="group" aria-label="Filter cameras by entry availability"><button type="button" [attr.aria-pressed]="availability === 'all'" (click)="availability = 'all'">All <span>{{ loading || error ? '—' : streams.length }}</span></button><button type="button" [attr.aria-pressed]="availability === 'open'" (click)="availability = 'open'">Open now <span>{{ openCameraCountLabel }}</span></button></div>
            <button class="tb-icon-btn" type="button" (click)="error ? load() : refreshRounds()" [disabled]="loading || roundsRefreshing" [attr.aria-label]="roundsRefreshing ? 'Updating rounds' : 'Refresh rounds'" title="Refresh"><app-icon name="refresh" [size]="17" [class.is-spinning]="roundsRefreshing"></app-icon></button>
          </div>
        </div>
        <p class="tb-alert" *ngIf="!loading && !marketsLoading && !error && !hasRoundErrors && streams.length && availability === 'all' && !availableRounds.length"><app-icon name="clock"></app-icon><span>No entries are open right now. New rounds appear here automatically — open a camera to watch in the meantime.</span></p>
        <p class="tb-alert is-warn" *ngIf="!loading && hasRoundErrors" role="alert"><app-icon name="alert"></app-icon><span>Some round information is unavailable. That doesn’t mean entries are closed — refresh to try again.</span></p>
        <div class="tb-loading" *ngIf="loading" role="status"><span class="tb-spinner"></span>Loading cameras…</div>
        <div class="tb-card tb-empty" *ngIf="error" role="alert"><span class="tb-empty-icon"><app-icon name="alert" [size]="24"></app-icon></span><h3>The camera list is unavailable</h3><p>{{ error }}</p><button class="tb-btn" type="button" (click)="load()">Try again</button></div>

        <div class="cam-grid" *ngIf="!loading && !error">
          <article class="cam-card" *ngFor="let stream of filtered; trackBy: trackCamera" [class.is-open]="!!nextRound(stream.id)">
            <a class="cam-media" [routerLink]="['/admin/cameras', stream.id]" [attr.aria-label]="'Open camera: ' + stream.title">
              <app-camera-scene *ngIf="preview" [variant]="stream.id"></app-camera-scene>
              <img *ngIf="!preview && thumbnail(stream) && !failedThumbnails[stream.id]" [src]="thumbnail(stream)" [alt]="(isReferenceImage(stream) ? 'Reference camera view: ' : 'Camera preview: ') + stream.title" loading="lazy" referrerpolicy="no-referrer" (load)="previewLoaded(stream.id, $event)" (error)="failedThumbnails[stream.id] = true">
              <div *ngIf="!preview && (!thumbnail(stream) || failedThumbnails[stream.id])" class="cam-placeholder"><app-icon name="camera" [size]="28"></app-icon><small>{{ failedThumbnails[stream.id] ? 'Preview unavailable' : 'Open to watch live' }}</small></div>
              <app-counting-overlay *ngIf="!preview && !failedThumbnails[stream.id] && thumbnail(stream)" [guide]="stream.countingGuide" [snapshot]="currentRound(stream.id)?.countingRules" [mediaWidth]="previewSizes[stream.id]?.width ?? 0" [mediaHeight]="previewSizes[stream.id]?.height ?? 0"></app-counting-overlay>
              <span class="cam-shade" aria-hidden="true"></span>
              <span class="tb-chip cam-state" [class.is-open]="!!nextRound(stream.id)" [class.is-live]="!nextRound(stream.id) && cameraStateLabel(stream.id) === 'Counting now'" [class.is-warn]="marketsLoading || marketErrors[stream.id]"><span class="tb-dot" [class.is-pulse]="!!nextRound(stream.id) || cameraStateLabel(stream.id) === 'Counting now'"></span>{{ cameraStateLabel(stream.id, stream.automationPause) }}</span>
              <span class="cam-timer tb-num" *ngIf="nextRound(stream.id) as market" [class.is-soon]="entryClosesSoon(market)" [attr.aria-label]="'Time left to predict: ' + closesIn(market)"><app-icon name="clock" [size]="14"></app-icon>{{ closesIn(market) }}</span>
              <span class="cam-play" aria-hidden="true"><app-icon name="play" [size]="22"></app-icon></span>
              <span class="cam-caption">{{ preview ? 'Illustrated preview' : failedThumbnails[stream.id] || !thumbnail(stream) ? feedLabel(stream) : isReferenceImage(stream) ? 'Still · ' + referenceDate(stream) : 'Preview image' }}</span>
            </a>
            <div class="cam-body">
              <p class="cam-loc">CAM {{ cameraNumber(stream.id) }} · {{ stream.city }}, {{ stream.country }}</p>
              <h3><a [routerLink]="['/admin/cameras', stream.id]">{{ stream.title }}</a></h3>
              <p class="cam-desc">{{ stream.locationLabel }}</p>
              <div class="monitor-current" *ngIf="currentRound(stream.id) as round"><span>{{ phaseLabel(round) }} · #{{ round.id }}</span><strong>{{ round.windowStart | date:'HH:mm:ss' }}–{{ round.windowEnd | date:'HH:mm:ss' }}</strong><a [routerLink]="['/admin/cameras', stream.id]" [queryParams]="{ round: round.id }" fragment="selected-round">Inspect this round →</a></div>
              <p class="monitor-pause" *ngIf="stream.automationPause">{{ stream.automationPause }}</p>
            </div>
            <div class="cam-foot">
              <ng-container *ngIf="nextRound(stream.id) as market; else noRound">
                <div class="cam-round"><span>{{ predictsNextRound(stream.id) ? 'Next round' : 'Round' }} #{{ market.id }}</span><strong class="tb-num">Count at {{ market.windowStart | date:'HH:mm:ss' }}</strong></div>
                <a class="tb-btn tb-btn-primary tb-btn-sm" [routerLink]="['/admin/cameras', stream.id]" [queryParams]="{ round: market.id }" [fragment]="'selected-round'">Inspect round<app-icon name="arrow" [size]="16"></app-icon></a>
              </ng-container>
              <ng-template #noRound>
                <div class="cam-round"><span>{{ marketsLoading ? 'Checking rounds…' : marketErrors[stream.id] ? 'Round info unavailable' : currentRound(stream.id) ? 'Round in progress' : stream.automationPause ? 'Rounds paused' : 'No open round' }}</span><small class="tb-num">{{ marketsLoading ? 'One moment…' : marketErrors[stream.id] ? 'Watch while we reconnect.' : !currentRound(stream.id) && stream.automationPause ? stream.automationPause : waitingLabel(stream.id) }}</small></div>
                <a class="tb-btn tb-btn-sm" [routerLink]="['/admin/cameras', stream.id]">Inspect camera<app-icon name="arrow" [size]="16"></app-icon></a>
              </ng-template>
            </div>
            <p class="cam-source">Source: <a *ngIf="sourcePage(stream); else plainSource" [href]="sourcePage(stream)" target="_blank" rel="noopener noreferrer">{{ stream.sourceOwner || 'Camera provider' }}</a><ng-template #plainSource><span>{{ stream.sourceOwner || 'Camera provider' }}</span></ng-template></p>
          </article>
        </div>
        <div class="tb-card tb-empty" *ngIf="!loading && !error && !filtered.length"><span class="tb-empty-icon"><app-icon name="search" [size]="24"></app-icon></span><h3>{{ streams.length ? (availability === 'open' ? (hasRoundErrors ? 'Some entries could not be checked' : 'No matching cameras are open right now') : 'No cameras match your search') : 'No cameras yet' }}</h3><p>{{ streams.length ? (availability === 'open' ? 'Show all cameras to watch and prepare, or keep this filter on — it updates automatically.' : 'Try a different city or a shorter search.') : 'A camera source must be connected before it appears here.' }}</p><button *ngIf="streams.length" type="button" class="tb-btn" (click)="clearFilters()">Show all cameras</button></div>
      </section>
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
  get attentionCount(): number { return this.streams.filter(stream => !!stream.automationPause || !!this.marketErrors[stream.id]).length; }
  cameraNumber(id: number): string { return String(id).padStart(3, '0'); }
  phaseLabel(market: Market): string { return roundPhaseLabels[roundPhase(market, this.now)]; }
  trackCamera(_index: number, stream: TrafficStream): number { return stream.id; }
  cameraStateLabel(streamId: number, automationPause?: string): string {
    if (this.marketsLoading) return 'Checking entries';
    if (this.marketErrors[streamId]) return 'Update unavailable';
    if (this.nextRound(streamId)) return this.predictsNextRound(streamId) ? 'Next round open' : 'Entries open';
    const current=this.currentRound(streamId);
    return current ? roundPhase(current,this.now)==='counting' ? 'Counting now' : 'Entries closed' : automationPause ? 'Rounds paused' : 'Waiting for a round';
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
