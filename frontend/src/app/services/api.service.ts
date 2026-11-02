import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { LiveRound, RangeQuote, RoundScheduleSettings, RoundScheduleSnapshot } from '../models';
import { AuditItem, CountingDefinition, CountingPreparation, CountingProfile, CountingReference, CursorPage, ReviewDetail, ReviewQueueItem, RoundReview, SourceHealth } from '../models';
import { Bet, BetSide, BetStatus, CreditLedgerEntry, Market, MarketPayload, SettlementVerification, StakeBetPage, StakeVolumeSnapshot, StreamMetric, StreamPayload, TrafficStream, User, UserPage } from '../models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiUrl;
  private readonly credentials = { withCredentials: true };
  health(): Observable<{ ok: boolean; automaticSettlement?: boolean }> { return this.http.get<{ ok: boolean; automaticSettlement?: boolean }>(`${this.base}/health`, this.credentials); }
  sourceHealth(): Observable<SourceHealth> { return this.http.get<SourceHealth>(`${this.base}/admin/source-health`, this.credentials); }
  preparation(id: number): Observable<CountingPreparation> { return this.http.get<CountingPreparation>(`${this.base}/admin/preparation/${id}`, this.credentials); }
  referenceURL(id: number, ref: number): string { return `${this.base}/admin/preparation/${id}/references/${ref}`; }
  uploadReference(id: number, file: File): Observable<CountingReference> { return this.http.post<CountingReference>(`${this.base}/admin/preparation/${id}/references`, file, { ...this.credentials, headers: { 'Content-Type': 'image/png' } }); }
  saveCountingProfile(id: number, referenceId: number, definition: CountingDefinition): Observable<CountingProfile> { return this.http.post<CountingProfile>(`${this.base}/admin/preparation/${id}/profiles`, { referenceId, definition }, this.credentials); }
  approveCountingProfile(id: number, profileId: number, note: string): Observable<unknown> { return this.http.post(`${this.base}/admin/preparation/${id}/approve/${profileId}`, { note }, this.credentials); }
  reviewQueue(before?: number): Observable<CursorPage<ReviewQueueItem>> { return this.http.get<CursorPage<ReviewQueueItem>>(`${this.base}/admin/round-review`, { ...this.credentials, params: before ? new HttpParams().set('before', before) : new HttpParams() }); }
  roundReview(id: number): Observable<ReviewDetail> { return this.http.get<ReviewDetail>(`${this.base}/admin/round-review/${id}`, this.credentials); }
  saveRoundReview(id: number, input: Pick<RoundReview, 'outcome' | 'proposedCount' | 'verification' | 'evidenceNote' | 'evidenceId'>): Observable<RoundReview> { return this.http.post<RoundReview>(`${this.base}/admin/round-review/${id}`, input, this.credentials); }
  auditPage(before?: number): Observable<CursorPage<AuditItem>> { return this.http.get<CursorPage<AuditItem>>(`${this.base}/admin/audit`, { ...this.credentials, params: before ? new HttpParams().set('before', before) : new HttpParams() }); }
  myLedger(): Observable<CreditLedgerEntry[]> { return this.http.get<CreditLedgerEntry[]>(`${this.base}/me/ledger`, { ...this.credentials, params: new HttpParams().set('limit', '100') }); }
  adminUsers(): Observable<User[]> { return this.http.get<User[]>(`${this.base}/admin/users`, this.credentials); }
  adminUserPage(page: number, pageSize: number, query: string): Observable<UserPage> {
    const params = new HttpParams().set('page', page).set('pageSize', pageSize).set('q', query);
    return this.http.get<UserPage>(`${this.base}/admin/users`, { ...this.credentials, params });
  }
  listStreams(): Observable<TrafficStream[]> { return this.http.get<TrafficStream[]>(`${this.base}/streams`, this.credentials); }
  getStream(id: number): Observable<TrafficStream> { return this.http.get<TrafficStream>(`${this.base}/streams/${id}`, this.credentials); }
  listMarkets(): Observable<Market[]> { return this.http.get<Market[]>(`${this.base}/admin/markets`, this.credentials); }
  listPublicMarkets(id: number, status = 'open'): Observable<Market[]> {
    return this.http.get<Market[]>(`${this.base}/streams/${id}/markets`, { ...this.credentials, params: new HttpParams().set('status', status) });
  }
  listMetrics(id: number): Observable<StreamMetric[]> { return this.http.get<StreamMetric[]>(`${this.base}/streams/${id}/metrics`, this.credentials); }
  createBet(marketId: number, side: BetSide, stakeCredits: number, idempotencyKey: string): Observable<{ bet: Bet; user: User }> {
    return this.http.post<{ bet: Bet; user: User }>(`${this.base}/bets`, { marketId, side, stakeCredits }, { ...this.credentials, headers: { 'Idempotency-Key': idempotencyKey } });
  }
  quoteRange(marketId: number, from: number, to: number): Observable<RangeQuote> {
    return this.http.get<RangeQuote>(`${this.base}/bets/range-quote`, { ...this.credentials, params: new HttpParams().set('marketId', marketId).set('from', from).set('to', to) });
  }
  rangeOptions(marketId: number): Observable<{ options: RangeQuote[] }> {
    return this.http.get<{ options: RangeQuote[] }>(`${this.base}/bets/range-options`, { ...this.credentials, params: new HttpParams().set('marketId', marketId) });
  }
  liveRound(marketId: number): Observable<LiveRound> { return this.http.get<LiveRound>(`${this.base}/markets/${marketId}/live`, this.credentials); }
  createRangeBet(quote: RangeQuote, stakeCredits: number, idempotencyKey: string): Observable<{ bet: Bet; user: User }> {
    return this.http.post<{ bet: Bet; user: User }>(`${this.base}/bets`, { marketId: quote.marketId, side: 'range', rangeMin: quote.rangeMin, rangeMax: quote.rangeMax, quotedOdds: quote.odds, pricingModel: quote.pricingModel, stakeCredits }, { ...this.credentials, headers: { 'Idempotency-Key': idempotencyKey } });
  }
  myBets(): Observable<Bet[]> { return this.http.get<Bet[]>(`${this.base}/bets/my`, this.credentials); }
  adminStreams(): Observable<TrafficStream[]> { return this.http.get<TrafficStream[]>(`${this.base}/admin/streams`, this.credentials); }
  roundSchedules(): Observable<RoundScheduleSnapshot> { return this.http.get<RoundScheduleSnapshot>(`${this.base}/admin/round-schedules`, this.credentials); }
  saveRoundSchedule(id: number, settings: RoundScheduleSettings): Observable<{ saved: boolean }> { return this.http.put<{ saved: boolean }>(`${this.base}/admin/round-schedules/${id}`, settings, this.credentials); }
  createStream(payload: StreamPayload): Observable<TrafficStream> { return this.http.post<TrafficStream>(`${this.base}/admin/streams`, payload, this.credentials); }
  updateStream(id: number, payload: StreamPayload): Observable<TrafficStream> { return this.http.put<TrafficStream>(`${this.base}/admin/streams/${id}`, payload, this.credentials); }
  archiveStream(id: number): Observable<unknown> { return this.http.delete(`${this.base}/admin/streams/${id}`, this.credentials); }
  restoreStream(id: number): Observable<TrafficStream> { return this.http.patch<TrafficStream>(`${this.base}/admin/streams/${id}/restore`, {}, this.credentials); }
  createMarket(payload: MarketPayload): Observable<Market> { return this.http.post<Market>(`${this.base}/admin/markets`, payload, this.credentials); }
  settleMarket(id: number, actualCount: number, verification: SettlementVerification): Observable<Market> { return this.http.patch<Market>(`${this.base}/admin/markets/${id}/settle`, { actualCount, verification }, this.credentials); }
  voidMarket(id: number, reason: string): Observable<Market> { return this.http.patch<Market>(`${this.base}/admin/markets/${id}/void`, { reason }, this.credentials); }
  adminBets(): Observable<Bet[]> { return this.http.get<Bet[]>(`${this.base}/admin/bets`, this.credentials); }
  stakeVolume(): Observable<StakeVolumeSnapshot> { return this.http.get<StakeVolumeSnapshot>(`${this.base}/admin/stake-volume`, this.credentials); }
  stakeDetails(streamId: number, marketId: number | undefined, status: BetStatus | 'all', page: number, pageSize: number): Observable<StakeBetPage> {
    let params = new HttpParams().set('streamId', streamId).set('status', status).set('page', page).set('pageSize', pageSize);
    if (marketId !== undefined) params = params.set('marketId', marketId);
    return this.http.get<StakeBetPage>(`${this.base}/admin/stake-volume/bets`, { ...this.credentials, params });
  }
}
