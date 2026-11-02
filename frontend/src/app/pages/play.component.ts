import { DecimalPipe, NgFor, NgIf } from '@angular/common';
import { Component, OnDestroy, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Subject, Subscription, catchError, debounceTime, forkJoin, map, of, switchMap, timeout } from 'rxjs';
import { VideoPlayerComponent } from '../components/video-player.component';
import { IconComponent } from '../components/icon.component';
import { Bet, LiveRound, Market, RangeQuote, TrafficStream } from '../models';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { LivePhase, aiBehind, liveCount, livePhase, mmss, payoutFor, pickMarket, playableStreams, randomItem, rangeLabel } from '../services/play-logic';
import { apiError, voidReasonLabel } from '../services/ui-helpers';

type Stage = 'idle' | 'finding' | 'betting' | 'placed' | 'empty';
type Choice = { kind: 'option'; index: number } | { kind: 'exact' };
interface Ticket { marketId: number; label: string; stake: number; payout: number; rangeMin: number; rangeMax: number; }

@Component({ selector: 'app-play', standalone: true, imports: [DecimalPipe, FormsModule, NgFor, NgIf, RouterLink, VideoPlayerComponent, IconComponent], styleUrl: './play.component.css', template: `
  <section class="play" [class.has-game]="!!stream && !!market">
    <div class="play-hero" *ngIf="!stream || !market">
      <span class="tb-chip is-live"><span class="tb-dot is-pulse"></span>Live road cameras · counted by AI</span>
      <h1>How many vehicles will cross the line?</h1>
      <p>We pick a live camera at random. Predict the next 30-second count, then watch the AI count it in real time. Payouts are automatic.</p>
      <button type="button" class="tb-btn tb-btn-primary play-cta" (click)="start()" [disabled]="stage === 'finding'">
        <span class="tb-spinner" *ngIf="stage === 'finding'"></span><app-icon *ngIf="stage !== 'finding'" name="play" [size]="20"></app-icon>{{ stage === 'finding' ? 'Finding a camera…' : 'Make a prediction' }}
      </button>
      <p class="play-note" *ngIf="stage === 'empty'" role="status">No camera is taking predictions right now. Trying again in a few seconds…</p>
      <p class="play-note is-error" *ngIf="error && stage !== 'empty'" role="alert">{{ error }}</p>
      <ol class="play-steps">
        <li><app-icon name="camera" [size]="18"></app-icon>A random live camera</li>
        <li><app-icon name="grid" [size]="18"></app-icon>Pick a range or an exact number</li>
        <li><app-icon name="eye" [size]="18"></app-icon>Watch the AI count live</li>
      </ol>
    </div>

    <ng-container *ngIf="stream && market">
      <div class="play-stage">
        <div class="play-video">
          <app-video-player [stream]="stream" [autoplay]="true" [countingSnapshot]="market.countingRules">
            <div vp-overlay class="hud" *ngIf="stage === 'placed'" [class.is-live]="phase === 'counting' && !behind" [class.is-behind]="behind" [class.is-done]="phase === 'result'">
              <div class="hud-count" [class.is-flash]="flash"><small>AI count</small><strong class="tb-num">{{ count }}</strong></div>
              <div class="hud-status"><span class="tb-spinner hud-spin" *ngIf="behind"></span><span class="hud-dot" *ngIf="phase === 'counting' && !behind"></span>{{ hudStatus }}</div>
            </div>
          </app-video-player>
        </div>
      </div>

      <aside class="play-slip tb-card" aria-live="polite">
        <header class="slip-head">
          <div class="slip-camera"><small>{{ stream.city }}{{ stream.country ? ', ' + stream.country : '' }}</small><h2>{{ stream.title }}</h2></div>
          <button *ngIf="stage !== 'placed'" type="button" class="tb-icon-btn" (click)="shuffle()" [disabled]="submitting || stage === 'finding'" title="Another random camera" aria-label="Show another random camera"><app-icon name="refresh" [size]="18"></app-icon></button>
        </header>

        <ng-container *ngIf="stage !== 'placed'">
          <div class="slip-timer" [class.is-soon]="closesIn <= 10">
            <app-icon name="clock" [size]="16"></app-icon><span>Entries close in</span><strong class="tb-num">{{ clock(closesIn) }}</strong>
            <small>Round #{{ market.id }}</small>
          </div>
          <p class="slip-question">Vehicles crossing the line in <b>{{ countSeconds }} s</b>:</p>
          <div class="slip-options" role="radiogroup" aria-label="Ready-made ranges">
            <button *ngFor="let option of options; let i = index" type="button" role="radio" class="slip-option" [class.is-on]="isOption(i)" [attr.aria-checked]="isOption(i)" (click)="chooseOption(i)" [disabled]="submitting">
              <span>{{ label(option) }}</span><b class="tb-num">{{ option.odds | number:'1.2-2' }}×</b>
            </button>
            <ng-container *ngIf="!options.length"><span class="slip-option is-skeleton" *ngFor="let _ of [1,2,3,4]"></span></ng-container>
          </div>
          <div class="slip-exact" [class.is-on]="choice.kind === 'exact'">
            <button type="button" role="radio" class="slip-exact-pick" [attr.aria-checked]="choice.kind === 'exact'" (click)="chooseExact()" [disabled]="submitting">Exact number<small>higher odds</small></button>
            <div class="slip-stepper">
              <button type="button" (click)="nudgeExact(-1)" [disabled]="submitting || exact <= 0" aria-label="One vehicle fewer"><app-icon name="minus" [size]="16"></app-icon></button>
              <input class="tb-num tb-no-spin" type="number" inputmode="numeric" min="0" [max]="maxExact" step="1" name="exact" [(ngModel)]="exact" (ngModelChange)="exactChanged()" (focus)="chooseExact()" aria-label="Exact number of vehicles" [disabled]="submitting">
              <button type="button" (click)="nudgeExact(1)" [disabled]="submitting || exact >= maxExact" aria-label="One vehicle more"><app-icon name="plus" [size]="16"></app-icon></button>
            </div>
            <b class="tb-num">{{ exactQuote && exactQuote.rangeMin === exact ? (exactQuote.odds | number:'1.2-2') + '×' : '…' }}</b>
          </div>
          <div class="slip-stake">
            <span>Stake</span>
            <div class="slip-presets"><button type="button" *ngFor="let amount of presets" [class.is-on]="stake === amount" (click)="stake = amount" [disabled]="submitting || amount > balance">{{ amount }}</button></div>
            <label class="slip-stake-input"><input class="tb-num tb-no-spin" type="number" inputmode="numeric" min="1" [max]="stakeLimit" step="1" name="stake" [(ngModel)]="stake" aria-label="Stake in credits" [disabled]="submitting"><span>cr</span></label>
          </div>
          <button type="button" class="tb-btn tb-btn-primary tb-btn-block slip-confirm" (click)="place()" [disabled]="!canPlace">
            <span class="tb-spinner" *ngIf="submitting"></span>
            <ng-container *ngIf="selectedQuote as quote; else pick">Bet {{ stake | number:'1.0-0' }} cr on {{ label(quote) }} · win {{ potential | number:'1.0-0' }} cr</ng-container>
            <ng-template #pick>Choose a range or number</ng-template>
          </button>
          <p class="slip-error" *ngIf="stakeProblem || error" role="alert">{{ stakeProblem || error }}</p>
        </ng-container>

        <ng-container *ngIf="stage === 'placed' && ticket">
          <div class="slip-ticket"><span>Your pick</span><strong>{{ ticket.label }} vehicles</strong><small>{{ ticket.stake | number:'1.0-0' }} cr · pays {{ ticket.payout | number:'1.0-0' }} cr</small></div>
          <div class="slip-live" *ngIf="phase !== 'result'">
            <div class="slip-live-count" [class.is-behind]="behind"><small>AI count</small><strong class="tb-num">{{ count }}{{ behind ? '+' : '' }}</strong></div>
            <div class="slip-live-text"><strong>{{ phaseTitle }}</strong><span>{{ phaseHint }}</span></div>
            <div class="slip-progress" *ngIf="phase === 'counting'"><span [style.width.%]="windowProgress"></span></div>
          </div>
          <div class="slip-result" *ngIf="phase === 'result' && live" [class.is-win]="won" [class.is-loss]="live.status === 'settled' && !won" [class.is-void]="live.status === 'void'">
            <app-icon [name]="live.status === 'void' ? 'info' : won ? 'trophy' : 'alert'" [size]="28"></app-icon>
            <ng-container *ngIf="live.status === 'settled'">
              <strong>{{ won ? 'You won ' + (ticket.payout | number:'1.0-0') + ' cr!' : 'Not this time' }}</strong>
              <span>The AI counted <b>{{ live.actualCount }}</b> vehicles · your pick was {{ ticket.label }}.</span>
            </ng-container>
            <ng-container *ngIf="live.status === 'void'">
              <strong>Round refunded</strong><span>{{ refundReason }} Your {{ ticket.stake | number:'1.0-0' }} cr is back.</span>
            </ng-container>
          </div>
          <button type="button" class="tb-btn tb-btn-primary tb-btn-block slip-confirm" (click)="playAgain()" [disabled]="phase !== 'result'">
            <app-icon name="play" [size]="18"></app-icon>{{ phase === 'result' ? 'Play again' : 'Waiting for the result…' }}
          </button>
          <a class="slip-link" routerLink="/bets">My predictions</a>
        </ng-container>
      </aside>
    </ng-container>
  </section>
` })
export class PlayComponent implements OnDestroy {
  private readonly api = inject(ApiService);
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  @ViewChild(VideoPlayerComponent) player?: VideoPlayerComponent;

  stage: Stage = 'idle';
  stream?: TrafficStream; market?: Market;
  options: RangeQuote[] = [];
  choice: Choice = { kind: 'option', index: 1 };
  exact = 0; exactQuote?: RangeQuote; private exactTouched = false;
  readonly presets = [10, 25, 50, 100];
  stake = 25; submitting = false; error = '';
  ticket?: Ticket; live?: LiveRound; displayed: number | null = null;
  phase: LivePhase = 'waiting'; count = 0; flash = false; behind = false;
  now = Date.now();
  readonly maxExact = 999;

  private tickTimer?: number; private pollTimer?: number; private retryTimer?: number; private flashTimer?: number;
  private findSub?: Subscription; private optionsSub?: Subscription; private liveSub?: Subscription; private betSub?: Subscription;
  private readonly exactQuotes = new Subject<{ marketId: number; value: number }>();
  private readonly exactSub = this.exactQuotes.pipe(debounceTime(200), switchMap(({ marketId, value }) =>
    this.api.quoteRange(marketId, value, value).pipe(catchError(() => of(undefined))))).subscribe((quote) => { this.exactQuote = quote; });
  private intent?: { fingerprint: string; key: string };
  private refreshingMarket = false; private balanceRefreshed = false; private destroyed = false;

  constructor() { this.tickTimer = window.setInterval(() => this.tick(), 250); }
  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.tickTimer) window.clearInterval(this.tickTimer);
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    if (this.flashTimer) window.clearTimeout(this.flashTimer);
    for (const sub of [this.findSub, this.optionsSub, this.liveSub, this.betSub, this.exactSub]) sub?.unsubscribe();
  }

  get balance(): number { return this.auth.user?.balanceCredits ?? 0; }
  get stakeLimit(): number { return Math.min(100000, this.balance); }
  get closesIn(): number { return this.market ? (Date.parse(this.market.bettingClosesAt) - this.now) / 1000 : 0; }
  get countSeconds(): number { return this.market ? Math.round((Date.parse(this.market.windowEnd) - Date.parse(this.market.windowStart)) / 1000) : 30; }
  get selectedQuote(): RangeQuote | undefined {
    if (this.choice.kind === 'option') return this.options[this.choice.index];
    return this.exactQuote && this.exactQuote.rangeMin === this.exact && this.exactQuote.rangeMax === this.exact ? this.exactQuote : undefined;
  }
  get potential(): number { const quote = this.selectedQuote; return quote ? payoutFor(Number(this.stake), quote.odds) : 0; }
  get stakeProblem(): string {
    const stake = Number(this.stake);
    if (!this.auth.user) return '';
    if (!Number.isInteger(stake) || stake < 1) return 'Enter a whole-number stake of at least 1 cr.';
    if (stake > this.stakeLimit) return this.balance < 1 ? 'You have no credits left to stake.' : `You can stake up to ${this.stakeLimit.toLocaleString('en')} cr.`;
    return '';
  }
  get canPlace(): boolean { return this.stage === 'betting' && !this.submitting && !!this.selectedQuote && !this.stakeProblem && this.closesIn > 1; }
  get won(): boolean { const actual = this.live?.actualCount; return !!this.ticket && actual !== undefined && actual >= this.ticket.rangeMin && actual <= this.ticket.rangeMax; }
  get refundReason(): string { return voidReasonLabel(this.live?.voidReason); }
  get windowProgress(): number {
    if (!this.market) return 0;
    const start = Date.parse(this.market.windowStart) / 1000, end = Date.parse(this.market.windowEnd) / 1000, t = this.displayed ?? this.now / 1000;
    return Math.min(100, Math.max(0, ((t - start) / (end - start)) * 100));
  }
  private get secondsToStart(): number { return this.market ? Date.parse(this.market.windowStart) / 1000 - (this.displayed ?? this.now / 1000) : 0; }
  private get secondsToEnd(): number { return this.market ? Date.parse(this.market.windowEnd) / 1000 - (this.displayed ?? this.now / 1000) : 0; }
  get phaseTitle(): string {
    switch (this.phase) {
      case 'waiting': return `Counting starts in ${mmss(this.secondsToStart)}`;
      case 'counting': return `Counting live · ${mmss(this.secondsToEnd)} left`;
      default: return 'Counting finished';
    }
  }
  get phaseHint(): string {
    switch (this.phase) {
      case 'waiting': return 'Watch the turquoise line. Every vehicle that crosses it is counted.';
      case 'counting': return this.behind ? 'The AI is a few seconds behind this video — the count will catch up.' : this.displayed === null ? 'The AI count updates as the video is analysed.' : 'The count follows the video you are watching.';
      default: return 'Confirming the AI result…';
    }
  }
  get hudStatus(): string {
    if (this.phase === 'waiting') return `Starts in ${mmss(this.secondsToStart)}`;
    if (this.behind) return this.phase === 'counting' ? `AI catching up · ${mmss(this.secondsToEnd)}` : 'AI catching up…';
    if (this.phase === 'counting') return `Live · ${mmss(this.secondsToEnd)}`;
    if (this.phase === 'checking') return 'Confirming…';
    return this.live?.status === 'void' ? 'Refunded' : 'Final';
  }

  label(quote: Pick<RangeQuote, 'rangeMin' | 'rangeMax'>): string { return rangeLabel(quote); }
  clock(seconds: number): string { return mmss(seconds); }
  isOption(index: number): boolean { return this.choice.kind === 'option' && this.choice.index === index; }
  chooseOption(index: number): void { if (!this.submitting) { this.choice = { kind: 'option', index }; this.error = ''; } }
  chooseExact(): void { if (!this.submitting) { this.choice = { kind: 'exact' }; this.error = ''; this.requestExactQuote(); } }
  nudgeExact(delta: number): void { this.exact = Math.min(this.maxExact, Math.max(0, Math.round(Number(this.exact) || 0) + delta)); this.exactChanged(); }
  exactChanged(): void { this.exactTouched = true; this.choice = { kind: 'exact' }; this.requestExactQuote(); }

  start(): void {
    if (!this.auth.user) { void this.router.navigate(['/login'], { queryParams: { returnUrl: '/' } }); return; }
    this.find();
  }
  shuffle(): void { if (!this.submitting) this.find(this.stream?.id); }
  playAgain(): void { this.resetRound(); this.find(this.stream?.id); }

  /** Pick a random camera that has a round accepting predictions, preferring a different one than `avoid`. */
  find(avoid?: number): void {
    this.error = ''; this.stage = 'finding'; this.findSub?.unsubscribe();
    if (this.retryTimer) { window.clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    this.findSub = this.api.listStreams().pipe(
      timeout(10_000),
      switchMap((streams) => {
        const candidates = playableStreams(streams);
        if (!candidates.length) return of([] as { stream: TrafficStream; market?: Market }[]);
        return forkJoin(candidates.map((stream) => this.api.listPublicMarkets(stream.id).pipe(
          timeout(10_000), map((markets) => ({ stream, market: pickMarket(markets, Date.now()) })), catchError(() => of({ stream, market: undefined })))));
      })
    ).subscribe({
      next: (found) => {
        const ready = found.filter((item) => !!item.market);
        const preferred = ready.filter((item) => item.stream.id !== avoid);
        const pick = randomItem(preferred.length ? preferred : ready);
        if (!pick?.market) { this.stream = undefined; this.market = undefined; this.stage = 'empty'; this.retryTimer = window.setTimeout(() => this.find(avoid), 8000); return; }
        this.showRound(pick.stream, pick.market);
      },
      error: (error) => { this.stage = 'idle'; this.stream = undefined; this.market = undefined; this.error = apiError(error, 'Cameras could not be loaded. Please try again.'); }
    });
  }

  private showRound(stream: TrafficStream, market: Market): void {
    const sameCamera = this.stream?.id === stream.id;
    this.stream = stream; this.market = market; this.stage = 'betting'; this.options = []; this.intent = undefined;
    if (!sameCamera || !this.exactTouched) { this.exact = Math.max(0, market.threshold); this.exactTouched = false; }
    if (!sameCamera) this.choice = { kind: 'option', index: 1 };
    this.exactQuote = undefined;
    this.optionsSub?.unsubscribe();
    this.optionsSub = this.api.rangeOptions(market.id).pipe(timeout(10_000)).subscribe({
      next: ({ options }) => { if (this.market?.id === market.id) { this.options = options; if (this.choice.kind === 'exact') this.requestExactQuote(); } },
      error: (error) => { if (this.market?.id === market.id) this.error = apiError(error, 'Odds could not be loaded.'); }
    });
    this.requestExactQuote();
  }

  private requestExactQuote(): void {
    const value = Math.round(Number(this.exact));
    if (!this.market || this.stage !== 'betting' || !Number.isInteger(value) || value < 0 || value > this.maxExact) return;
    this.exactQuotes.next({ marketId: this.market.id, value });
  }

  /** Entries for the shown round are closing: move to the camera's next round, keeping the player's choice. */
  private nextRoundSameCamera(): void {
    const stream = this.stream;
    if (!stream || this.refreshingMarket) return;
    this.refreshingMarket = true;
    this.api.listPublicMarkets(stream.id).pipe(timeout(10_000)).subscribe({
      next: (markets) => {
        this.refreshingMarket = false;
        if (this.stream?.id !== stream.id || this.stage !== 'betting') return;
        const next = pickMarket(markets, Date.now());
        if (next) this.showRound(stream, next); else this.find(stream.id);
      },
      error: () => { this.refreshingMarket = false; if (this.stage === 'betting') this.find(stream.id); }
    });
  }

  place(): void {
    const quote = this.selectedQuote, market = this.market, stake = Number(this.stake), user = this.auth.user;
    if (!this.canPlace || !quote || !market || !user) return;
    const fingerprint = JSON.stringify([user.id, market.id, quote.rangeMin, quote.rangeMax, quote.odds, stake]);
    if (this.intent?.fingerprint !== fingerprint) this.intent = { fingerprint, key: crypto.randomUUID() };
    this.submitting = true; this.error = '';
    this.betSub = this.api.createRangeBet(quote, stake, this.intent.key).pipe(timeout(15_000)).subscribe({
      next: ({ bet, user: updated }) => {
        this.submitting = false; this.intent = undefined;
        if (this.auth.user?.id === updated.id) this.auth.updateUser(updated);
        this.beginLive(bet, quote);
      },
      error: (error) => {
        this.submitting = false;
        if (error?.status > 0 && error.status < 500) this.intent = undefined;
        this.error = apiError(error);
        if (error?.status === 409) this.nextRoundSameCamera();
      }
    });
  }

  private beginLive(bet: Bet, quote: RangeQuote): void {
    this.ticket = { marketId: bet.marketId, label: rangeLabel(quote), stake: bet.stakeCredits, payout: bet.potentialPayoutCredits, rangeMin: quote.rangeMin, rangeMax: quote.rangeMax };
    this.stage = 'placed'; this.live = undefined; this.displayed = null; this.count = 0; this.phase = 'waiting'; this.balanceRefreshed = false;
    this.poll();
    this.pollTimer = window.setInterval(() => this.poll(), 2000);
  }

  private poll(): void {
    const ticket = this.ticket;
    if (!ticket || (this.liveSub && !this.liveSub.closed)) return;
    this.liveSub = this.api.liveRound(ticket.marketId).pipe(timeout(8000)).subscribe({
      next: (round) => { if (this.ticket?.marketId === round.marketId) this.live = round; },
      error: () => { /* transient: the next poll retries */ }
    });
  }

  private resetRound(): void {
    if (this.pollTimer) { window.clearInterval(this.pollTimer); this.pollTimer = undefined; }
    this.liveSub?.unsubscribe(); this.ticket = undefined; this.live = undefined; this.displayed = null; this.count = 0; this.phase = 'waiting';
  }

  private tick(): void {
    if (this.destroyed) return;
    this.now = Date.now();
    if (this.stage === 'betting' && this.market && !this.submitting && this.closesIn <= 1) this.nextRoundSameCamera();
    if (this.stage !== 'placed' || !this.market) return;
    const segments = this.live?.live?.segments;
    this.displayed = segments?.length ? this.player?.displayedCaptureTime(segments) ?? null : null;
    const round = this.live ?? { status: 'open' as const, windowStart: this.market.windowStart, windowEnd: this.market.windowEnd };
    this.phase = livePhase(round, this.displayed, this.now);
    this.behind = aiBehind(this.live, this.displayed, this.now, this.phase);
    const next = this.phase === 'result' && this.live?.status === 'settled' ? this.live.actualCount ?? 0 : liveCount(this.live, this.displayed);
    if (next > this.count) this.pulse();
    this.count = next;
    if (this.phase === 'result') {
      if (this.pollTimer) { window.clearInterval(this.pollTimer); this.pollTimer = undefined; }
      if (!this.balanceRefreshed) { this.balanceRefreshed = true; this.auth.refreshMe().subscribe({ error: () => {} }); }
    }
  }

  private pulse(): void {
    this.flash = true;
    if (this.flashTimer) window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => { this.flash = false; }, 650);
  }
}
