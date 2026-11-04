import { DatePipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { Component, DestroyRef, OnDestroy, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription, distinctUntilChanged, forkJoin, map, timeout } from 'rxjs';
import { CountingRulesComponent } from '../components/counting-rules.component';
import { VideoPlayerComponent } from '../components/video-player.component';
import { LiveCameraCounterComponent } from '../components/live-camera-counter.component';
import { IconComponent } from '../components/icon.component';
import { BetSide, Market, RangeQuote, StreamMetric, TrafficStream } from '../models';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { apiError } from '../services/ui-helpers';
import { acceptsPredictions, roundPhase, roundPhaseLabels } from '../services/round-state';

@Component({ selector: 'app-stream-detail', standalone: true, imports: [DatePipe, DecimalPipe, FormsModule, NgFor, NgIf, RouterLink, VideoPlayerComponent, LiveCameraCounterComponent, CountingRulesComponent, IconComponent], template: `
  <a class="cd-back" [routerLink]="auth.isAdmin ? '/admin/cameras' : '/'"><app-icon name="back" [size]="16"></app-icon>{{ auth.isAdmin ? 'All cameras' : 'Back to play' }}</a>
  <div class="tb-loading" *ngIf="loading" role="status"><span class="tb-spinner"></span>Loading camera…</div>
  <div *ngIf="error" class="tb-card tb-empty" role="alert"><span class="tb-empty-icon"><app-icon name="alert" [size]="24"></app-icon></span><h3>Camera unavailable</h3><p>{{ error }}</p><button class="tb-btn" type="button" (click)="load()">Try again</button></div>
  <section class="cd" *ngIf="stream && !loading && !error">
    <div class="tb-alert is-warn" *ngIf="refreshError" role="status"><app-icon name="alert"></app-icon><p>{{ refreshError }} <button class="tb-link" type="button" (click)="load(true)" [disabled]="refreshing">Retry</button></p></div>
    <header class="cd-head">
      <div class="cd-title">
        <p class="cd-loc"><app-icon name="pin" [size]="15"></app-icon>{{ stream.city }}, {{ stream.country }}</p>
        <h1>{{ stream.title }}</h1>
        <p class="cd-sub">{{ stream.locationLabel }}</p>
      </div>
      <div class="cd-head-actions">
        <a class="tb-btn tb-btn-sm" routerLink="/bets" *ngIf="auth.user"><app-icon name="ticket" [size]="16"></app-icon>My predictions</a>
        <a class="tb-btn tb-btn-primary tb-btn-sm cd-jump" href="#camera-prediction">Predict<app-icon name="arrow" [size]="16"></app-icon></a>
      </div>
    </header>

    <div class="cd-grid">
      <div class="cd-video">
        <app-video-player #videoPlayer [stream]="stream" [countingSnapshot]="cameraCounter.snapshot ?? displayedRound?.countingRules" [autoplay]="true" [highlightFrames]="cameraCounter.highlights" [highlightCrossings]="cameraCounter.crossings" [highlightCaptureTime]="cameraCounter.displayed">
          <app-live-camera-counter #cameraCounter vp-overlay [stream]="stream" [player]="videoPlayer"></app-live-camera-counter>
        </app-video-player>
      </div>

      <aside class="cd-side">
        <section class="tb-card slip" id="camera-prediction" tabindex="-1" aria-labelledby="camera-rounds-heading">
          <header class="slip-head">
            <h2 id="camera-rounds-heading">Make a prediction</h2>
            <button class="tb-icon-btn slip-refresh" type="button" (click)="load(true)" [disabled]="refreshing" [attr.aria-label]="refreshing ? 'Updating rounds' : 'Refresh rounds'" [attr.title]="lastUpdated ? 'Updated ' + (lastUpdated | date:'HH:mm:ss') + ' · updates automatically' : 'Refresh'"><app-icon name="refresh" [size]="16" [class.is-spinning]="refreshing"></app-icon></button>
          </header>

          <div class="tb-alert is-warn" *ngIf="!selectedMarket && entryMarkets.length && !message && !uncertainSubmission"><p>That round no longer accepts predictions. <button class="tb-link" type="button" (click)="chooseRound(entryMarkets[0])" [disabled]="submitting">Use the next round →</button></p></div>

          <article class="slip-round" *ngIf="composerMarket as market" [attr.id]="'round-' + market.id" tabindex="-1">
            <div class="tb-alert is-error" *ngIf="uncertainSubmission" role="alert"><p>The last request wasn’t confirmed and may already have spent credits. <a routerLink="/bets">Check My predictions →</a></p></div>

            <div class="slip-timer" *ngIf="isSelectedMarket(market) && !hasAcceptedPrediction(market)" [class.is-soon]="entryClosesSoon(market)">
              <div class="slip-timer-main"><span>Entries close in</span><strong class="tb-num" role="timer" aria-live="off" [attr.aria-label]="'Time left to predict: ' + closesIn(market)">{{ closesIn(market) }}</strong></div>
              <div class="slip-timer-meta"><span class="tb-chip is-open">{{ targetingNextRound ? 'Next round' : 'Round' }} #{{ market.id }}</span><small class="tb-num">Count {{ market.windowStart | date:'HH:mm:ss' }}–{{ market.windowEnd | date:'HH:mm:ss' }} · {{ durationSeconds(market) }} s</small></div>
            </div>
            <div class="slip-draft" *ngIf="!isSelectedMarket(market)"><span class="tb-chip">Draft · round #{{ market.id }}</span><p>The next round is being checked. You can prepare your pick now; nothing is spent until its odds are available and you confirm.</p></div>
            <div class="target-change" role="status" aria-live="polite"><p class="tb-alert slip-rollover" *ngIf="rolloverNotice && rolloverNotice.marketId === market.id && !message"><app-icon name="refresh" [size]="16"></app-icon><span>Switched to <strong>round #{{ market.id }}</strong> (count starts {{ rolloverNotice.startsAt | date:'HH:mm:ss' }}). Your pick and stake were kept — check the new odds.</span></p></div>

            <form *ngIf="auth.user; else signInToPrepare" class="slip-form" (ngSubmit)="confirmPrediction(market)" [attr.aria-label]="'Prediction for round ' + market.id">
              <ng-container *ngIf="!hasAcceptedPrediction(market); else acceptedPrediction">
                <fieldset class="slip-step" [disabled]="submitting">
                  <legend><span class="slip-step-n">1</span>How many vehicles will cross the line?</legend>
                  <div class="tb-seg is-block" role="group" aria-label="Prediction type"><button type="button" [attr.aria-pressed]="editingSide === 'range'" (click)="chooseSide(market, 'range')">Exact range</button><button type="button" [attr.aria-pressed]="editingSide === 'under' || editingSide === 'over'" (click)="chooseSide(market, 'under')">Over / Under</button></div>

                  <ng-container *ngIf="editingSide === 'range'">
                    <div class="slip-range">
                      <div class="tb-field"><label [attr.for]="'range-from-' + market.id">From</label>
                        <span class="slip-stepper"><button type="button" (click)="nudgeRange(market, 'min', -1)" aria-label="Decrease minimum"><app-icon name="minus" [size]="16"></app-icon></button><input class="tb-no-spin tb-num" type="number" inputmode="numeric" min="0" max="100000000" step="1" required [id]="'range-from-' + market.id" [name]="'from-' + market.id" [attr.aria-invalid]="!!rangeError(market)" [(ngModel)]="rangeMinimums[market.id]" (ngModelChange)="rangeChanged(market)" [attr.aria-describedby]="'range-help-' + market.id"><button type="button" (click)="nudgeRange(market, 'min', 1)" aria-label="Increase minimum"><app-icon name="plus" [size]="16"></app-icon></button></span>
                      </div>
                      <div class="tb-field"><label [attr.for]="'range-to-' + market.id">To</label>
                        <span class="slip-stepper"><button type="button" (click)="nudgeRange(market, 'max', -1)" aria-label="Decrease maximum"><app-icon name="minus" [size]="16"></app-icon></button><input class="tb-no-spin tb-num" type="number" inputmode="numeric" min="0" max="100000000" step="1" required [id]="'range-to-' + market.id" [name]="'to-' + market.id" [attr.aria-invalid]="!!rangeError(market)" [(ngModel)]="rangeMaximums[market.id]" (ngModelChange)="rangeChanged(market)" [attr.aria-describedby]="'range-help-' + market.id"><button type="button" (click)="nudgeRange(market, 'max', 1)" aria-label="Increase maximum"><app-icon name="plus" [size]="16"></app-icon></button></span>
                      </div>
                    </div>
                    <p class="tb-help" [class.is-error]="!!rangeError(market)" [id]="'range-help-' + market.id">{{ rangeError(market) || ('You win if the count is ' + rangeMinimums[market.id] + '–' + rangeMaximums[market.id] + ' vehicles (both included).') }}</p>
                    <div class="slip-odds" role="status"><span>{{ quoteLoading ? 'Calculating odds…' : currentRangeQuote(market) ? 'Odds for this range' : !isSelectedMarket(market) ? 'Waiting for the next round’s odds' : quoteError || 'Enter a valid range to see odds' }}</span><strong *ngIf="currentRangeQuote(market) as quote" class="tb-num">{{ quote.odds | number:'1.2-2' }}×</strong><span class="tb-spinner" *ngIf="quoteLoading"></span><button *ngIf="quoteError" type="button" class="tb-link" (click)="requestRangeQuote(market)">Retry</button></div>
                    <details class="slip-pricing"><summary>How are range odds calculated?</summary><p>Range odds come from a fixed demo model around this round’s reference threshold ({{ market.threshold }}), with a 15% margin and a 10× cap. Narrow ranges pay more; very wide ranges may only return your stake. They are not real traffic probabilities.</p></details>
                  </ng-container>

                  <div class="slip-outcomes" *ngIf="editingSide === 'under' || editingSide === 'over'">
                    <button class="slip-outcome" type="button" [class.is-selected]="editingSide === 'under'" [attr.aria-pressed]="editingSide === 'under'" (click)="chooseSide(market, 'under')"><span>Under or equal</span><strong class="tb-num">{{ rangeLabel(market, 'under') }}</strong><em class="tb-num">{{ market.oddsUnder | number:'1.2-2' }}×</em></button>
                    <button class="slip-outcome" type="button" [class.is-selected]="editingSide === 'over'" [attr.aria-pressed]="editingSide === 'over'" (click)="chooseSide(market, 'over')"><span>Over</span><strong class="tb-num">{{ rangeLabel(market, 'over') }}</strong><em class="tb-num">{{ market.oddsOver | number:'1.2-2' }}×</em></button>
                  </div>
                </fieldset>

                <div class="slip-step">
                  <label class="slip-legend" [attr.for]="'stake-' + market.id"><span class="slip-step-n">2</span>Your stake</label>
                  <div class="slip-stake"><input [id]="'stake-' + market.id" class="tb-input tb-no-spin tb-num" type="number" inputmode="numeric" required min="1" [max]="stakeLimit" step="1" [name]="'stake-' + market.id" [(ngModel)]="stakes[market.id]" (ngModelChange)="rememberDraft(market)" [attr.aria-describedby]="'stake-help-' + market.id" [attr.aria-invalid]="auth.user && !!stakeError(market)" [disabled]="!auth.user || submitting"><span aria-hidden="true">cr</span></div>
                  <div class="slip-presets" aria-label="Quick stake amounts"><button type="button" *ngFor="let amount of stakePresets" (click)="setStake(market, amount)" [attr.aria-pressed]="stakes[market.id] === amount" [disabled]="!auth.user || amount > stakeLimit || submitting">{{ amount }}</button></div>
                  <p class="tb-help" [class.is-error]="auth.user && !!stakeError(market)" [id]="'stake-help-' + market.id">{{ auth.user ? (stakeError(market) || 'Available: ' + (auth.user.balanceCredits | number:'1.0-0') + ' cr') : 'Sign in to use your virtual balance.' }}</p>
                </div>

                <dl class="slip-summary" aria-label="Prediction summary">
                  <div><dt>Your pick</dt><dd class="tb-num">{{ editingSide ? rangeLabel(market, editingSide) + ' vehicles' : '—' }}</dd></div>
                  <div><dt>Odds</dt><dd class="tb-num">{{ displayOdds(market) !== undefined ? (displayOdds(market) | number:'1.2-2') + '×' : '—' }}</dd></div>
                  <div><dt>Stake</dt><dd class="tb-num">{{ validStake(market) ? (stakes[market.id] | number:'1.0-0') + ' cr' : '—' }}</dd></div>
                  <div class="is-return"><dt>Potential return</dt><dd class="tb-num">{{ potentialReturn(market) !== undefined ? (potentialReturn(market) | number:'1.0-0') + ' cr' : '—' }}</dd></div>
                </dl>

                <button class="tb-btn tb-btn-primary tb-btn-lg tb-btn-block slip-confirm" type="submit" [disabled]="!canConfirm(market)" [attr.aria-describedby]="'confirmation-help-' + market.id"><span class="tb-spinner" *ngIf="submitting"></span>{{ confirmationLabel(market) }}<small *ngIf="canConfirm(market)" class="tb-num">· {{ stakes[market.id] | number:'1.0-0' }} cr</small></button>
                <p class="tb-help slip-confirm-help" [class.sr-only]="canConfirm(market) && !uncertainSubmission" [id]="'confirmation-help-' + market.id">{{ confirmationHelp(market) }}</p>
                <p class="tb-alert is-error slip-error" *ngIf="betError" role="alert">{{ betError }}</p>
                <p class="slip-fineprint">Credits are spent only when you confirm. A loss returns 0 cr; a cancelled round refunds your stake.</p>
              </ng-container>
            </form>

            <ng-template #acceptedPrediction><div class="slip-success" role="status"><span class="slip-success-icon"><app-icon name="check" [size]="26"></app-icon></span><h3>Prediction placed!</h3><p>{{ message }}</p><div class="slip-success-actions"><a class="tb-btn tb-btn-primary" routerLink="/bets">Track result<app-icon name="arrow" [size]="16"></app-icon></a><button class="tb-btn" type="button" (click)="startAnotherPrediction(market)">Make another</button></div></div></ng-template>
            <ng-template #signInToPrepare><div class="slip-signin"><span class="tb-empty-icon"><app-icon name="user" [size]="24"></app-icon></span><strong>Sign in to make a prediction</strong><p>Guess the vehicle count, check the odds and stake virtual credits. New accounts start with 10,000 cr.</p><a class="tb-btn tb-btn-primary tb-btn-block" routerLink="/login" [queryParams]="{ returnUrl: '/streams/' + stream.id }">Sign in</a><a class="tb-btn tb-btn-ghost tb-btn-block" routerLink="/register" [queryParams]="{ returnUrl: '/streams/' + stream.id }">Create a free account</a></div></ng-template>

            <details class="tb-details slip-rules"><summary>Counting zone &amp; round rules</summary><div class="tb-details-body"><app-counting-rules [snapshot]="isSelectedMarket(market) ? market.countingRules : undefined"></app-counting-rules><p *ngIf="!isSelectedMarket(market)">The next published round will supply its counting rules. Check its line and directions before confirming.</p><p *ngIf="isSelectedMarket(market) && !market.countingRules">Only vehicles crossing the published counting zone during the counting window are included.</p></div></details>
          </article>

          <div class="slip-waiting" *ngIf="!activeMarkets.length"><span class="tb-spinner" *ngIf="!stream.automationPause"></span><app-icon *ngIf="stream.automationPause" name="info" [size]="20"></app-icon><div><strong>{{ stream.automationPause ? 'Rounds paused for this camera' : 'Waiting for the next round' }}</strong><p>{{ stream.automationPause ? stream.automationPause + ' Rounds resume automatically once this is resolved.' : 'This panel checks automatically every few seconds.' }}</p></div></div>
          <a *ngIf="!auth.user && !composerMarket" class="tb-btn tb-btn-primary tb-btn-block" routerLink="/login" [queryParams]="{ returnUrl: '/streams/' + stream.id }">Sign in to predict</a>
          <details class="tb-details slip-rules"><summary>Deadlines, camera movement &amp; refunds</summary><div class="tb-details-body"><p>Entries close at least 30 seconds before counting starts; playback delay doesn’t extend the deadline. An AI counts every round automatically from the camera’s own footage and clock. If footage is incomplete, the capture time can’t be verified or the camera moves during a round, the round is voided and stakes are refunded.</p></div></details>
          <p class="slip-updated" *ngIf="lastUpdated">Updated {{ lastUpdated | date:'HH:mm:ss' }} · updates automatically</p>
        </section>
        <p class="cd-trust"><app-icon name="shield" [size]="16"></app-icon>Counted automatically by AI · unverifiable rounds are refunded</p>
      </aside>

      <div class="cd-info">
        <section class="tb-card cd-panel">
          <header class="cd-panel-head"><div><p class="tb-kicker">Count history</p><h2>Vehicles per round</h2></div><span class="tb-chip">{{ metrics.length }} {{ metrics.length === 1 ? 'record' : 'records' }}</span></header>
          <div class="cd-chart" *ngIf="metrics.length" aria-label="Vehicle counts for recent intervals"><div class="cd-bar" *ngFor="let metric of chartMetrics"><strong class="tb-num">{{ metric.vehicleCount }}</strong><span class="cd-bar-fill" [style.height.%]="barHeight(metric)" [class.is-ai]="metric.source === 'ai'"></span><small class="tb-num">{{ metric.intervalEnd | date:'HH:mm' }}</small></div></div>
          <ul class="cd-metrics" *ngIf="metrics.length"><li *ngFor="let metric of metrics.slice(0, 5)"><div><strong class="tb-num">{{ metric.vehicleCount }} vehicles</strong><small class="tb-num">{{ metric.intervalStart | date:'MMM d, HH:mm:ss' }}–{{ metric.intervalEnd | date:'HH:mm:ss' }}</small></div><span class="tb-chip" [class.is-info]="metric.source === 'ai'">{{ metric.source === 'ai' ? 'AI count' : 'Operator' }}</span></li></ul>
          <div class="tb-empty cd-empty" *ngIf="!metrics.length"><span class="tb-empty-icon"><app-icon name="chart" [size]="22"></app-icon></span><p>No verified counts yet. Finished rounds appear here after verification.</p></div>
        </section>
        <section class="tb-card cd-panel">
          <header class="cd-panel-head"><div><p class="tb-kicker">About this camera</p><h2>Behind the lens</h2></div></header>
          <p class="cd-desc">{{ stream.description || 'No description has been added for this camera yet.' }}</p>
          <dl class="cd-facts">
            <div><dt>Source operator</dt><dd>{{ stream.sourceOwner || 'Not specified' }}</dd></div>
            <div *ngIf="safeSourceLink(stream.sourcePageUrl)"><dt>Source website</dt><dd><a [href]="safeSourceLink(stream.sourcePageUrl)" target="_blank" rel="noopener noreferrer" class="tb-link">Visit source<app-icon name="external" [size]="14"></app-icon></a></dd></div>
            <div *ngIf="safeSourceLink(stream.termsUrl)"><dt>Licence</dt><dd><a [href]="safeSourceLink(stream.termsUrl)" target="_blank" rel="noopener noreferrer" class="tb-link">Read licence<app-icon name="external" [size]="14"></app-icon></a></dd></div>
          </dl>
          <p *ngIf="stream.sourceOwner === &quot;Transport for London&quot;" class="cd-desc"><a class="tb-link" href="https://tfl.gov.uk/info-for/open-data-users/our-open-data" target="_blank" rel="noopener noreferrer">Powered by TfL Open Data<app-icon name="external" [size]="14"></app-icon></a></p>
          <p class="tb-help" *ngIf="stream.usageNotes">{{ stream.usageNotes }}</p>
        </section>
      </div>
    </div>
  </section>
`, styleUrl: './stream-detail.component.css' })
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
  readonly stakePresets = [25, 50, 100, 250];
  private choice?: { marketId: number; side?: BetSide; query: string };
  private draftMarket?: Market;
  private draftSide?: BetSide = 'range';
  private lastRouteChoice?: string;
  private receiptMarketId?: number;
  uncertainSubmission = false;
  private knownRequestedRoundId?: number;
  rolloverNotice?: { fromId: number; marketId: number; startsAt: string };
  get entryMarkets(): Market[] { return this.markets.filter(market => market.streamId === this.stream?.id && this.acceptsBets(market)).sort((a,b) => Date.parse(a.windowStart)-Date.parse(b.windowStart) || a.id-b.id); }
  get observingRound(): Market | undefined { return this.activeMarkets.find(market => this.phase(market) === 'counting') ?? this.activeMarkets.find(market => this.phase(market) === 'locked'); }
  get targetingNextRound(): boolean { return !!this.observingRound && !!this.selectedMarket && Date.parse(this.selectedMarket.windowStart) > Date.parse(this.observingRound.windowStart); }
  syncEntryRound(): void {
    if (this.submitting || this.uncertainSubmission || this.message || !this.stream?.isActive) return;
    const queryRounds = this.route.snapshot?.queryParamMap?.getAll('round') ?? [];
    // Malformed and foreign URL selections still require an explicit recovery.
    if (queryRounds.length) {
      const requested = this.requestedRoundId;
      if (requested === undefined) return;
      if (this.markets.some(market => market.id === requested && market.streamId === this.stream?.id)) this.knownRequestedRoundId = requested;
      else if (this.knownRequestedRoundId !== requested) return;
    }
    if (this.selectedMarket) return;
    const next = this.entryMarkets[0];
    if (next) this.chooseRound(next, false);
  }
  rangeMinimums: Record<number, number> = {};
  rangeMaximums: Record<number, number> = {};
  quoteLoading = false; quoteError = '';
  private rangeQuote?: RangeQuote;
  private quoteRequest?: Subscription;
  private quoteTimer?: ReturnType<typeof setTimeout>;
  private quoteGeneration = 0;
  private quoteIdentity = '';

  private get choiceQuery(): string { return JSON.stringify(['round', 'side'].map(key => this.route.snapshot?.queryParamMap?.getAll(key) ?? [])); }
  private get localChoice() { return this.choice?.query === this.choiceQuery ? this.choice : undefined; }
  get stakeLimit(): number { return Math.min(100000, this.auth.user?.balanceCredits ?? 100000); }
  // A draft may outlive its entry window. Only selectedMarket is eligible to spend credits.
  get composerMarket(): Market | undefined { return this.selectedMarket ?? (this.draftMarket?.streamId === this.stream?.id ? this.draftMarket : undefined) ?? this.activeMarkets[0]; }
  get editingSide(): BetSide | undefined {
    if (!this.composerMarket) return undefined;
    return this.selectedMarket ? this.selectedSide : this.draftSide;
  }
  rememberDraft(market: Market): void {
    if (!this.submitting && market.streamId === this.stream?.id && this.composerMarket?.id === market.id) this.draftMarket = market;
  }
  hasAcceptedPrediction(market: Market): boolean { return !!this.message && this.receiptMarketId === market.id; }
  startAnotherPrediction(market: Market): void {
    if (this.submitting || this.composerMarket?.id !== market.id) return;
    this.message = ''; this.receiptMarketId = undefined;
    this.chooseSide(market, 'range');
    this.syncEntryRound();
  }
  private syncRouteChoice(): boolean {
    if (this.lastRouteChoice === this.choiceQuery) return false;
    this.lastRouteChoice = this.choiceQuery;
    this.message = ''; this.betError = ''; this.receiptMarketId = undefined; this.rolloverNotice = undefined; this.cancelQuote();
    const selected = this.selectedMarket;
    if (selected) { this.draftMarket = selected; this.draftSide = this.selectedSide; }
    return true;
  }
  confirmationLabel(market: Market): string {
    if (this.submitting) return 'Placing prediction…';
    if (this.uncertainSubmission && (!this.acceptsBets(market) || !this.selectedSide || this.intent?.fingerprint !== this.predictionFingerprint(market, this.selectedSide))) return 'Check previous prediction';
    if (!this.isSelectedMarket(market)) return 'Waiting for the next round';
    if (!this.selectedSide) return 'Choose a prediction type';
    if (this.selectedSide === 'range' && this.rangeError(market)) return 'Check your range';
    if (!this.validStake(market)) return 'Check your stake';
    if (this.quoteLoading) return 'Calculating demo odds…';
    if (this.selectedSide === 'range' && !this.currentRangeQuote(market)) return 'Waiting for demo odds';
    return 'Place prediction';
  }
  confirmationHelp(market: Market): string {
    if (this.submitting) return 'Waiting for confirmation. Please do not submit again.';
    if (this.uncertainSubmission) return 'The last request may have been accepted. Retry the same unchanged prediction while entries are open, or check My predictions before placing a new one.';
    if (!this.isSelectedMarket(market)) return 'Your draft is saved on this page. The next published round will be selected when available. Review its time and current odds before confirming.';
    if (!this.auth.user) return 'Sign in first. You can enter your range and stake after returning to this camera.';
    if (!this.selectedSide) return 'Select Custom range or Over / under to start another prediction.';
    if (this.selectedSide === 'range' && this.rangeError(market)) return this.rangeError(market);
    if (this.stakeError(market)) return this.stakeError(market);
    if (this.selectedSide === 'range' && !this.currentRangeQuote(market)) return this.quoteError || 'A current server quote is needed before any credits can be spent.';
    return `Confirm ${Number(this.stakes[market.id]).toLocaleString('en')} virtual credits for round #${market.id}. When this entry closes, the form switches to the next published round; it never places a stake automatically.`;
  }
  rangeLabel(market: Market, side: BetSide): string { return side === 'range' ? `${this.rangeMinimums[market.id]}–${this.rangeMaximums[market.id]}` : side === 'under' ? `0–${market.threshold}` : `${market.threshold + 1}+`; }
  durationSeconds(market: Market): number { return Math.round((Date.parse(market.windowEnd) - Date.parse(market.windowStart)) / 1000); }
  countdownTo(value: string): string {
    const remaining = Date.parse(value) - this.now;
    if (!Number.isFinite(remaining)) return '—';
    const total = Math.max(0, Math.ceil(remaining / 1000));
    const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
    return `${hours ? hours.toString().padStart(2, '0') + ':' : ''}${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  entryClosesSoon(market: Market): boolean { const remaining = Date.parse(market.bettingClosesAt) - this.now; return this.acceptsBets(market) && remaining > 0 && remaining <= 10000; }
  closesIn(market: Market): string {
    const remaining = Date.parse(market.bettingClosesAt) - this.now;
    return Number.isFinite(remaining) && remaining > 0 ? this.countdownTo(market.bettingClosesAt) : 'Closed';
  }
  chooseRound(market: Market, moveFocus = true): void {
    if (this.submitting || market.streamId !== this.stream?.id || !this.acceptsBets(market)) return;
    const previous = this.composerMarket, side = this.editingSide ?? 'range';
    if (previous && previous.id !== market.id) {
      this.rangeMinimums[market.id] = this.rangeMinimums[previous.id];
      this.rangeMaximums[market.id] = this.rangeMaximums[previous.id];
      this.stakes[market.id] = this.stakes[previous.id];
      this.rolloverNotice = { fromId: previous.id, marketId: market.id, startsAt: market.windowStart };
    }
    this.draftMarket = market;
    this.draftSide = side;
    this.choice = { marketId: market.id, side, query: this.choiceQuery };
    this.betError = ''; this.message = '';
    this.cancelQuote();
    if (side === 'range') this.requestRangeQuote(market);
    if (moveFocus) this.focusComposer(market);
  }
  chooseSide(market: Market, side: BetSide): void {
    if (side !== 'under' && side !== 'over' && side !== 'range') return;
    if (this.submitting || market.streamId !== this.stream?.id || this.composerMarket?.id !== market.id) return;
    const selected = this.isSelectedMarket(market);
    this.draftMarket = market;
    this.draftSide = side;
    if (selected) this.choice = { marketId: market.id, side, query: this.choiceQuery };
    this.betError = ''; this.message = '';
    this.cancelQuote();
    if (side === 'range') this.requestRangeQuote(market);
  }
  rangeError(market: Market): string {
    const from=this.rangeMinimums[market.id], to=this.rangeMaximums[market.id];
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from > 100000000 || to > 100000000) return 'Enter whole vehicle counts from 0 to 100,000,000.';
    return from > to ? 'From must be less than or equal to To.' : '';
  }
  private quoteKey(market: Market): string { return JSON.stringify([this.auth.user?.id, this.auth.sessionGeneration, market.id, market.threshold, this.rangeMinimums[market.id], this.rangeMaximums[market.id]]); }
  private cancelQuote(): void {
    this.quoteGeneration++; this.quoteRequest?.unsubscribe();
    if (this.quoteTimer !== undefined) clearTimeout(this.quoteTimer);
    this.quoteTimer=undefined; this.rangeQuote=undefined; this.quoteIdentity=''; this.quoteLoading=false; this.quoteError='';
  }
  rangeChanged(market: Market): void {
    if (this.submitting) return;
    this.rememberDraft(market);
    this.cancelQuote(); this.betError=''; this.message='';
    if (this.rangeError(market) || !this.auth.user || !this.isSelectedMarket(market)) return;
    this.quoteLoading=true;
    this.quoteTimer=setTimeout(() => { this.quoteTimer=undefined; this.requestRangeQuote(market); },350);
  }
  currentRangeQuote(market: Market): RangeQuote | undefined {
    return this.isSelectedMarket(market) && this.selectedSide==='range' && this.quoteIdentity===this.quoteKey(market) && !this.rangeError(market) ? this.rangeQuote : undefined;
  }
  requestRangeQuote(market: Market): void {
    this.cancelQuote();
    if (this.destroyed || this.submitting || !this.auth.user || !this.isSelectedMarket(market) || this.selectedSide!=='range' || !this.acceptsBets(market) || this.rangeError(market)) return;
    const generation=this.quoteGeneration, identity=this.quoteKey(market);
    this.quoteLoading=true; this.quoteIdentity=identity;
    this.quoteRequest=this.api.quoteRange(market.id,this.rangeMinimums[market.id],this.rangeMaximums[market.id]).pipe(timeout(8000),takeUntilDestroyed(this.destroyRef)).subscribe({
      next: quote => {
        if (generation!==this.quoteGeneration) return;
        this.quoteLoading=false;
        if (identity!==this.quoteKey(market) || !this.isSelectedMarket(market) || this.selectedSide!=='range') return;
        if (quote.marketId!==market.id || quote.rangeMin!==this.rangeMinimums[market.id] || quote.rangeMax!==this.rangeMaximums[market.id] || quote.pricingModel!=='demo_normal_v2' || !Number.isFinite(quote.odds) || quote.odds<1 || quote.odds>10 || Math.abs(quote.odds*100-Math.round(quote.odds*100))>0.000001) { this.quoteError='Could not verify demo odds. Please retry.'; return; }
        this.rangeQuote=quote;
      },
      error: error => { if (generation!==this.quoteGeneration) return; this.quoteLoading=false; if (identity===this.quoteKey(market)) this.quoteError=apiError(error,'Could not calculate demo odds. Please retry.'); }
    });
  }
  nudgeRange(market: Market, bound: 'min' | 'max', delta: number): void {
    if (this.submitting || this.composerMarket?.id !== market.id) return;
    const values = bound === 'min' ? this.rangeMinimums : this.rangeMaximums;
    const current = Number.isInteger(values[market.id]) ? values[market.id] : market.threshold;
    values[market.id] = Math.min(100000000, Math.max(0, current + delta));
    this.rangeChanged(market);
  }
  displayOdds(market: Market): number | undefined {
    const side = this.isSelectedMarket(market) ? this.selectedSide : undefined;
    if (side === 'range') return this.currentRangeQuote(market)?.odds;
    return side === 'over' ? market.oddsOver : side === 'under' ? market.oddsUnder : undefined;
  }
  setStake(market: Market, amount: number): void {
    if (!this.submitting && this.auth.user && this.composerMarket?.id === market.id && Number.isInteger(amount) && amount >= 1 && amount <= this.stakeLimit) { this.stakes[market.id] = amount; this.rememberDraft(market); }
  }
  stakeError(market: Market): string {
    if (!this.auth.user) return '';
    if (this.auth.user.balanceCredits < 1) return 'You have no credits available to stake.';
    const stake = Number(this.stakes[market.id]);
    if (!Number.isInteger(stake) || stake < 1) return 'Enter a whole-number stake of at least 1 cr.';
    if (stake > this.stakeLimit) return `Your maximum available stake is ${this.stakeLimit.toLocaleString('en')} cr.`;
    return '';
  }
  validStake(market: Market): boolean { return !!this.auth.user && !this.stakeError(market); }
  potentialReturn(market: Market): number | undefined {
    const side = this.isSelectedMarket(market) ? this.selectedSide : undefined;
    if (!side || !this.validStake(market)) return undefined;
    const odds = side === 'range' ? this.currentRangeQuote(market)?.odds : side === 'over' ? market.oddsOver : market.oddsUnder;
    // Match the Go payout calculation: integer hundredths, rounded to a whole credit.
    if (odds === undefined || !Number.isFinite(odds) || odds < 1 || odds > 100) return undefined;
    return Math.floor((Number(this.stakes[market.id]) * Math.round(odds * 100) + 50) / 100);
  }
  confirmPrediction(market: Market): void {
    const side = this.isSelectedMarket(market) ? this.selectedSide : undefined;
    if (side && this.canConfirm(market)) this.placeBet(market, side);
  }
  private predictionFingerprint(market: Market, side: BetSide): string {
    const quote = side === 'range' ? this.currentRangeQuote(market) : undefined;
    return JSON.stringify([this.auth.user?.id, market.id, side, Number(this.stakes[market.id]), quote?.rangeMin, quote?.rangeMax, quote?.odds, quote?.pricingModel]);
  }
  canConfirm(market: Market): boolean { return this.isSelectedMarket(market) && !!this.selectedSide && this.validStake(market) && this.acceptsBets(market) && !this.submitting && (this.selectedSide!=='range' || !!this.currentRangeQuote(market)) && (!this.uncertainSubmission || this.intent?.fingerprint === this.predictionFingerprint(market, this.selectedSide!)); }

  // URL choices only guide the form. They never create a prediction or alter its stake.
  get requestedRoundId(): number | undefined {
    const values = this.route.snapshot?.queryParamMap?.getAll('round') ?? [];
    if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) return undefined;
    const id = Number(values[0]);
    return Number.isSafeInteger(id) ? id : undefined;
  }
  get selectedSide(): BetSide | undefined {
    if (this.localChoice) return this.selectedMarket ? this.localChoice.side : undefined;
    const values = this.route.snapshot?.queryParamMap?.getAll('side') ?? [];
    return this.selectedMarket ? (values.length===0 ? 'range' : values.length===1 && (values[0]==='over' || values[0]==='under' || values[0]==='range') ? values[0] : undefined) : undefined;
  }
  get selectedMarket(): Market | undefined {
    const id = this.localChoice?.marketId ?? this.requestedRoundId;
    return id === undefined ? undefined : this.markets.find((market) => market.id === id && market.streamId === this.stream?.id && this.acceptsBets(market));
  }
  get displayedRound(): Market | undefined {
    return this.selectedMarket ?? this.observingRound ?? this.entryMarkets[0];
  }
  get requestedRoundUnavailable(): boolean { return (this.localChoice?.marketId ?? this.requestedRoundId) !== undefined && !this.loading && !this.selectedMarket; }
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
      case 'verifying': return 'The counting window has ended. The AI result is being processed; credits settle automatically.';
      default: return 'This round is unavailable for predictions.';
    }
  }
  ngOnInit(): void {
    this.route.paramMap.pipe(map((params) => Number(params.get('id'))), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef)).subscribe((id) => {
      this.cancelRoundAnchor(); this.initialAnchorHandled = false;
      this.streamId = id; this.stream = undefined; this.markets = []; this.metrics = []; this.stakes = {};
      this.betError = ''; this.message = ''; this.intent = undefined; this.uncertainSubmission = false; this.lastUpdated = undefined;
      this.choice = undefined; this.draftMarket = undefined; this.draftSide = 'range'; this.lastRouteChoice = undefined; this.receiptMarketId = undefined; this.knownRequestedRoundId = undefined; this.rolloverNotice = undefined; this.cancelQuote(); this.rangeMinimums={}; this.rangeMaximums={};
      this.load();
    });
    this.route.queryParamMap?.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.syncRouteChoice()) {
        this.syncEntryRound();
        if (this.selectedMarket && this.selectedSide === 'range' && !this.quoteLoading) this.requestRangeQuote(this.selectedMarket);
      }
    });
    this.timer = window.setInterval(() => { this.now = Date.now(); this.syncEntryRound(); }, 1000);
    this.refreshTimer = window.setInterval(() => { if (!document.hidden && !this.loading && !this.refreshing && !this.submitting && this.stream) this.load(true); }, 5000);
  }
  ngOnDestroy(): void {
    this.destroyed = true; this.cancelRoundAnchor(); this.cancelQuote();
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
          this.markets.forEach((market) => { this.stakes[market.id] ??= 25; this.rangeMinimums[market.id] ??= Math.max(0,market.threshold-5); this.rangeMaximums[market.id] ??= Math.min(100000000,market.threshold+5); });
          this.now = Date.now(); this.lastUpdated = new Date(); this.loading = false; this.refreshing = false;
          this.syncRouteChoice();
          if (!this.draftMarket) { this.draftMarket = this.selectedMarket ?? this.entryMarkets[0] ?? this.activeMarkets[0] ?? this.markets.find(market => market.streamId === this.stream?.id); this.draftSide = this.selectedSide ?? 'range'; }
          this.syncEntryRound();
          if (!background) this.followInitialRoundAnchor();
          const selected=this.selectedMarket;
          if (selected && this.selectedSide==='range' && this.auth.user && !this.quoteLoading && !this.currentRangeQuote(selected) && !this.quoteError) this.requestRangeQuote(selected);
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
  private focusComposer(market: Market): void {
    this.cancelRoundAnchor();
    if (typeof window === 'undefined' || typeof document === 'undefined' || typeof window.requestAnimationFrame !== 'function' || typeof document.getElementById !== 'function') return;
    const generation = this.anchorGeneration, streamId = this.streamId;
    this.anchorFrame = window.requestAnimationFrame(() => {
      if (this.destroyed || generation !== this.anchorGeneration || streamId !== this.streamId || this.selectedMarket?.id !== market.id) return;
      this.anchorFrame = undefined;
      const target = document.getElementById(this.auth.user && this.editingSide === 'range' ? `range-from-${market.id}` : `round-${market.id}`);
      target?.scrollIntoView({ block: 'center', behavior: 'auto' });
      target?.focus({ preventScroll: true });
    });
  }
  private followInitialRoundAnchor(): void {
    if (this.initialAnchorHandled) return;
    this.initialAnchorHandled = true;
    const market = this.selectedMarket;
    if (this.requestedRoundId === undefined) return;
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
    const quote=side==='range' ? this.currentRangeQuote(market) : undefined;
    if (side==='range' && !quote) { this.betError='Review the demo odds for your range before placing.'; return; }
    const fingerprint = this.predictionFingerprint(market, side);
    if (this.uncertainSubmission && this.intent?.fingerprint !== fingerprint) { this.betError = 'The previous request may have been accepted. Check My predictions before changing the stake or round.'; return; }
    this.submitting = true;
    if (this.intent?.fingerprint !== fingerprint) this.intent = { fingerprint, key: crypto.randomUUID() };
    const label=side==='range' && quote ? `${quote.rangeMin}–${quote.rangeMax}` : this.rangeLabel(market,side);
    const query=this.choiceQuery;
    const request=quote ? this.api.createRangeBet(quote,stake,this.intent.key) : this.api.createBet(market.id, side, stake, this.intent.key);
    request.pipe(timeout(15_000)).subscribe({
      next: ({ user }) => {
        if (this.auth.user?.id === userId && this.auth.sessionGeneration === sessionGeneration) this.auth.updateUser(user);
        this.submitting = false;
        if (this.streamId !== streamId || this.auth.user?.id!==userId || this.auth.sessionGeneration!==sessionGeneration || this.choiceQuery !== query) return;
        this.intent = undefined; this.uncertainSubmission = false; this.message = `${stake} cr staked on ${label} vehicles in round #${market.id}. Your available balance is ${user.balanceCredits.toLocaleString('en')} cr. Follow the result in My predictions.`;
        this.receiptMarketId = market.id;
        if (this.choiceQuery===query && this.selectedMarket?.id===market.id) { this.choice = { marketId: market.id, query }; this.cancelQuote(); }
      },
      error: (error) => {
        this.submitting = false;
        if (this.streamId !== streamId || this.auth.user?.id!==userId || this.auth.sessionGeneration!==sessionGeneration || this.choiceQuery !== query) return;
        if (error.status > 0 && error.status < 500) this.intent = undefined;
        this.uncertainSubmission = !(error.status > 0 && error.status < 500);
        this.betError = apiError(error);
        if (error.status === 409) { this.cancelQuote(); this.load(true); }
      }
    });
  }
}
