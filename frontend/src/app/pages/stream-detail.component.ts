import { DatePipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { Component, DestroyRef, OnDestroy, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription, distinctUntilChanged, forkJoin, map, timeout } from 'rxjs';
import { CountingRulesComponent } from '../components/counting-rules.component';
import { VideoPlayerComponent } from '../components/video-player.component';
import { BetSide, Market, RangeQuote, StreamMetric, TrafficStream } from '../models';
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
    <div class="camera-quick-actions"><a class="button primary" href="#camera-prediction">Make a prediction ↓</a><a class="text-button" routerLink="/bets" *ngIf="auth.user">My predictions →</a><span>Virtual credits · confirm before spending</span></div>
    <div class="detail-layout">
      <div class="watch-column"><app-video-player [stream]="stream" [countingSnapshot]="displayedRound?.countingRules"></app-video-player>
        <p class="video-rule-context" *ngIf="stream.countingGuide || displayedRound?.countingRules?.definition"><strong>{{ displayedRound?.countingRules?.definition ? 'Counting rules · round #' + displayedRound?.id : 'Camera guide · preview only' }}</strong><span *ngIf="displayedRound?.countingRules?.definition && selectedMarket">Check the published counting zone and lanes in the round rules below.</span></p>
          <div class="round-context-strip" *ngIf="observingRound as current"><div><span class="round-context-label">CURRENT ROUND · #{{ current.id }}</span><strong>{{ phase(current) === 'counting' ? 'Counting window in progress' : 'Entries finished · counting soon' }}</strong></div><div class="current-round-timer"><span>{{ phase(current) === 'counting' ? 'Counting ends in' : 'Counting starts in' }}</span><strong role="timer" aria-live="off">{{ countdownTo(phase(current) === 'counting' ? current.windowEnd : current.windowStart) }}</strong></div><div><span>Counting time · local</span><strong>{{ current.windowStart | date:'HH:mm:ss' }} — {{ current.windowEnd | date:'HH:mm:ss' }}</strong></div><p>You can place your prediction on the next round below.</p></div></div>
      <section class="prediction-column" id="camera-prediction" tabindex="-1" aria-labelledby="camera-rounds-heading">
        <div class="panel prediction-panel">
          <div class="prediction-intro"><div><div class="eyebrow"><span class="dot orange"></span> PREDICT WITH VIRTUAL CREDITS</div><h2 id="camera-rounds-heading">Make your prediction</h2><p class="small-note">Enter your range and stake. We show the nearest round still accepting predictions.</p></div><div class="prediction-balance" *ngIf="auth.user"><span>Your available balance</span><strong>{{ auth.user.balanceCredits | number:'1.0-0' }} <small>cr</small></strong></div><span class="tag neutral" *ngIf="!auth.user">Virtual credits only</span></div>
          <div class="round-update-row"><p class="small-note" *ngIf="lastUpdated">Updated {{ lastUpdated | date:'HH:mm:ss' }} · updates automatically.</p><button class="text-button" type="button" (click)="load(true)" [disabled]="refreshing">{{ refreshing ? 'Updating…' : 'Refresh' }}</button></div>
          <div class="notice" *ngIf="!selectedMarket && entryMarkets.length && !message && !uncertainSubmission"><p>That round cannot accept your prediction. Use the next available round to continue.</p><button class="button" type="button" (click)="chooseRound(entryMarkets[0])" [disabled]="submitting">Use next round →</button></div>
          <article class="prediction-composer" *ngIf="composerMarket as market" [attr.id]="'round-' + market.id" tabindex="-1">
            <p class="notice" *ngIf="uncertainSubmission" role="alert">The last prediction request has not been confirmed. It may already have spent credits. <a class="text-button" routerLink="/bets">Check My predictions →</a></p>
            <header class="composer-heading"><div class="composer-identity"><span class="round-identity-mark" aria-hidden="true">#</span><div><span class="round-kind">{{ hasAcceptedPrediction(market) ? 'Your prediction' : isSelectedMarket(market) ? (targetingNextRound ? 'Next round' : 'Upcoming round') : 'Prediction draft' }}</span><h3>Round <span>#{{ market.id }}</span></h3></div></div><span class="tag round-entry-status" [class.closed-tag]="!isSelectedMarket(market) && !hasAcceptedPrediction(market)">{{ hasAcceptedPrediction(market) ? 'Prediction accepted' : isSelectedMarket(market) ? 'Entries open' : 'Draft · not submitted' }}</span></header>
            <div class="target-change" role="status" aria-live="polite"><p *ngIf="rolloverNotice && rolloverNotice.marketId === market.id && !message"><span class="round-update-mark" aria-hidden="true">↻</span><span>Switched to <strong>round #{{ market.id }}</strong> · starts <strong>{{ rolloverNotice.startsAt | date:'HH:mm:ss' }}</strong>. Range and stake kept; review the new odds.</span></p></div>
            <div class="round-overview" *ngIf="isSelectedMarket(market)" [class.accepted-round]="hasAcceptedPrediction(market)">
              <div class="round-timers" *ngIf="!hasAcceptedPrediction(market)">
                <div class="entry-timer" [class.closing-soon]="entryClosesSoon(market)"><span>Time left to predict</span><strong role="timer" aria-live="off" [attr.aria-label]="'Time left to predict: ' + closesIn(market)">{{ closesIn(market) }}</strong><small>{{ entryClosesSoon(market) ? 'Closing soon · ' : 'Closes ' }}{{ market.bettingClosesAt | date:'HH:mm:ss' }}</small></div>
                <div class="count-start-timer"><span>Counting starts in</span><strong role="timer" aria-live="off" [attr.aria-label]="'Counting starts in: ' + countdownTo(market.windowStart)">{{ countdownTo(market.windowStart) }}</strong><small>{{ durationSeconds(market) }}-second count</small></div>
              </div>
              <div class="prediction-target-time"><span>{{ targetingNextRound ? 'Next counting window' : 'Counting window' }}</span><div class="target-clock"><time [attr.datetime]="market.windowStart">{{ market.windowStart | date:'HH:mm:ss' }}</time><span aria-hidden="true">–</span><time [attr.datetime]="market.windowEnd">{{ market.windowEnd | date:'HH:mm:ss' }}</time></div><small>{{ market.windowStart | date:'MMM d' }} · {{ durationSeconds(market) }} seconds · local time</small></div>
            </div>
            <p class="composer-context" *ngIf="!isSelectedMarket(market)">The next published round is being checked. You can prepare your range and stake here; credits cannot be spent until its time and current odds are available.</p>
                <form *ngIf="auth.user; else signInToPrepare" class="round-stake-area prediction-form" (ngSubmit)="confirmPrediction(market)" [attr.aria-label]="'Prediction for round ' + market.id">
                  <ng-container *ngIf="!hasAcceptedPrediction(market); else acceptedPrediction"><div class="composer-fields"><fieldset class="range-picker" [disabled]="submitting"><legend><span class="field-step" aria-hidden="true">1</span> Expected vehicles</legend>
                    <div class="prediction-modes" aria-label="Prediction type"><button type="button" class="button" [attr.aria-pressed]="editingSide === 'range'" (click)="chooseSide(market, 'range')">From / To range</button><button type="button" class="button" [attr.aria-pressed]="editingSide === 'under' || editingSide === 'over'" (click)="chooseSide(market, 'under')">Over / under</button></div>
                    <ng-container *ngIf="editingSide === 'range'"><div class="range-bounds"><label>From <small>minimum vehicles</small><input type="number" inputmode="numeric" min="0" max="100000000" step="1" required [id]="'range-from-' + market.id" [name]="'from-' + market.id" [attr.aria-invalid]="!!rangeError(market)" [(ngModel)]="rangeMinimums[market.id]" (ngModelChange)="rangeChanged(market)" [attr.aria-describedby]="'range-help-' + market.id"></label><span aria-hidden="true">—</span><label>To <small>maximum vehicles</small><input type="number" inputmode="numeric" min="0" max="100000000" step="1" required [id]="'range-to-' + market.id" [name]="'to-' + market.id" [attr.aria-invalid]="!!rangeError(market)" [(ngModel)]="rangeMaximums[market.id]" (ngModelChange)="rangeChanged(market)" [attr.aria-describedby]="'range-help-' + market.id"></label></div>
                    <p class="small-note" [class.error]="!!rangeError(market)" [id]="'range-help-' + market.id">{{ rangeError(market) || ('You win if the verified count is from ' + rangeMinimums[market.id] + ' to ' + rangeMaximums[market.id] + ' vehicles, including both bounds.') }}</p>
                    <p class="range-quote-status" role="status">{{ quoteLoading ? 'Calculating demo odds…' : currentRangeQuote(market) ? 'Demo odds: ' + (currentRangeQuote(market)?.odds | number:'1.2-2') + '×' : !isSelectedMarket(market) ? 'Waiting for the next published round and its odds.' : auth.user ? quoteError || 'Enter valid bounds to see your demo odds.' : 'Sign in to calculate demo odds.' }}</p><button *ngIf="quoteError && auth.user" type="button" class="text-button" (click)="requestRangeQuote(market)">Retry odds</button>
                    <details class="range-pricing-note"><summary>How are these demo odds calculated?</summary><p>Custom-range odds use a fixed simulation model based on this round’s reference threshold ({{ market.threshold }}), a 5% model margin and a 100× cap. They are not measured traffic probabilities. Wider ranges generally give a smaller return; very broad ranges can return only the original stake.</p></details></ng-container>
                    <div class="choice-row" *ngIf="editingSide === 'under' || editingSide === 'over'"><button class="outcome-button under range-choice" type="button" [class.selected-outcome]="editingSide === 'under'" [attr.aria-pressed]="editingSide === 'under'" (click)="chooseSide(market, 'under')"><span>{{ rangeLabel(market, 'under') }} vehicles</span><strong>{{ market.oddsUnder | number:'1.2-2' }}× return</strong><small>{{ editingSide === 'under' ? '✓ Selected' : 'Select range' }}</small></button><button class="outcome-button range-choice" type="button" [class.selected-outcome]="editingSide === 'over'" [attr.aria-pressed]="editingSide === 'over'" (click)="chooseSide(market, 'over')"><span>{{ rangeLabel(market, 'over') }} vehicles</span><strong>{{ market.oddsOver | number:'1.2-2' }}× return</strong><small>{{ editingSide === 'over' ? '✓ Selected' : 'Select range' }}</small></button></div>
                  </fieldset>
                  <label class="stake-field" [attr.for]="'stake-' + market.id"><span><span class="field-step" aria-hidden="true">2</span> Virtual stake <small>· cr</small></span></label>
                  <input [id]="'stake-' + market.id" class="prediction-stake-input" type="number" inputmode="numeric" required min="1" [max]="stakeLimit" step="1" [name]="'stake-' + market.id" [(ngModel)]="stakes[market.id]" (ngModelChange)="rememberDraft(market)" [attr.aria-describedby]="'stake-help-' + market.id" [attr.aria-invalid]="auth.user && !!stakeError(market)" [disabled]="!auth.user || submitting">
                  <div class="stake-presets" aria-label="Quick stake amounts"><button class="button compact" type="button" *ngFor="let amount of stakePresets" (click)="setStake(market, amount)" [attr.aria-pressed]="stakes[market.id] === amount" [class.is-active]="stakes[market.id] === amount" [disabled]="!auth.user || amount > stakeLimit || submitting">{{ amount }} cr</button></div>
                  <p class="small-note" [class.error]="auth.user && !!stakeError(market)" [id]="'stake-help-' + market.id">{{ auth.user ? (stakeError(market) || 'Whole credits only. You can change the amount before confirming.') : 'Sign in to use your virtual balance.' }}</p>
                  </div><div class="composer-summary"><h4 class="review-heading"><span class="field-step" aria-hidden="true">3</span> Review &amp; confirm</h4><div class="stake-review" aria-label="Prediction summary"><div *ngIf="isSelectedMarket(market)"><span>Counting round</span><strong>#{{ market.id }} · {{ market.windowStart | date:'HH:mm:ss' }}</strong></div><div><span>Your prediction</span><strong>{{ editingSide ? rangeLabel(market, editingSide) + ' vehicles' : 'Choose a range above' }}</strong></div><div><span>Stake on confirmation</span><strong>{{ validStake(market) ? (stakes[market.id] | number:'1.0-0') + ' cr' : '—' }}</strong></div><div class="return-preview"><span>Return if you win <small>Includes your stake</small></span><strong>{{ potentialReturn(market) !== undefined ? (potentialReturn(market) | number:'1.0-0') + ' cr' : '—' }}</strong></div><div *ngIf="auth.user"><span>Balance if accepted</span><strong>{{ validStake(market) ? ((auth.user.balanceCredits - stakes[market.id]) | number:'1.0-0') + ' cr' : '—' }}</strong></div></div>
                  <button *ngIf="auth.user" class="button primary confirm-prediction" type="submit" [disabled]="!canConfirm(market)" [attr.aria-describedby]="'confirmation-help-' + market.id">{{ confirmationLabel(market) }}<small *ngIf="canConfirm(market)">{{ stakes[market.id] | number:'1.0-0' }} cr · round #{{ market.id }}</small></button>
                                    <p class="confirmation-help" [id]="'confirmation-help-' + market.id">{{ confirmationHelp(market) }}</p>
                  <p class="error message" *ngIf="betError" role="alert">{{ betError }}</p>
                  <p class="small-note place-action-note">Selecting a range does not spend credits. A losing prediction returns 0 cr; a cancelled round refunds your stake.</p></div></ng-container>
                </form>
            <ng-template #acceptedPrediction><div class="prediction-success" role="status"><span aria-hidden="true">✓</span><div><h4>Prediction accepted</h4><p>{{ message }}</p><div class="prediction-success-actions"><a class="button primary" routerLink="/bets">Follow the result →</a><button class="button" type="button" (click)="startAnotherPrediction(market)">Prepare another prediction</button></div></div></div></ng-template>
            <ng-template #signInToPrepare><div class="composer-sign-in"><strong>Sign in to prepare your prediction</strong><p>Enter a vehicle-count range, review the demo odds and choose your virtual stake. Your balance is charged only after you confirm.</p><a class="button primary" routerLink="/login" [queryParams]="{ returnUrl: '/streams/' + stream.id }">Sign in →</a><a class="text-button" routerLink="/register" [queryParams]="{ returnUrl: '/streams/' + stream.id }">Create an account</a></div></ng-template>
            <details class="composer-rules"><summary>Counting zone &amp; round rules</summary><app-counting-rules [snapshot]="isSelectedMarket(market) ? market.countingRules : undefined"></app-counting-rules><p class="small-note" *ngIf="!isSelectedMarket(market)">The next published round will supply its counting rules. Check its line and directions before confirming.</p></details>
          </article>
          <div class="empty-note" *ngIf="!activeMarkets.length">Waiting for the next round. This page checks automatically every 5 seconds. Your past predictions remain in My predictions.</div>
          <a *ngIf="!auth.user && !composerMarket" class="button primary sign-in-prediction" routerLink="/login" [queryParams]="{ returnUrl: '/streams/' + stream.id }">Sign in to predict →</a>
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
        if (quote.marketId!==market.id || quote.rangeMin!==this.rangeMinimums[market.id] || quote.rangeMax!==this.rangeMaximums[market.id] || quote.pricingModel!=='demo_geometric_v1' || !Number.isFinite(quote.odds) || quote.odds<1 || quote.odds>100 || Math.abs(quote.odds*100-Math.round(quote.odds*100))>0.000001) { this.quoteError='Could not verify demo odds. Please retry.'; return; }
        this.rangeQuote=quote;
      },
      error: error => { if (generation!==this.quoteGeneration) return; this.quoteLoading=false; if (identity===this.quoteKey(market)) this.quoteError=apiError(error,'Could not calculate demo odds. Please retry.'); }
    });
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
      case 'verifying': return 'The counting window has ended. An operator must verify the result before credits are settled.';
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
