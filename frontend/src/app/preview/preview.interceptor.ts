import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { defer, delay, of } from 'rxjs';
import { Bet, CreditLedgerEntry, Market, MarketPayload, StakeAmounts, StakeVolumeSnapshot, StreamMetric, StreamPayload, TrafficStream, User } from '../models';
import { RoundScheduleSettings } from '../models';

// Imported exclusively through the preview configuration file replacement.
// Memory belongs to this tab. Nothing is persisted, sent to a server, or used in production.
const time = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();
const users: User[] = [
  { id: 1, email: 'user@demo.local', displayName: 'Alex', role: 'user', balanceCredits: 1000, createdAt: time(-1440) },
  { id: 2, email: 'admin@demo.local', displayName: 'Administrator', role: 'admin', balanceCredits: 1000, createdAt: time(-1440) }
];
let currentUser: User | undefined;
const streams: TrafficStream[] = [
  { id: 1, title: 'Vltava riverfront', city: 'Prague', country: 'Czechia', locationLabel: 'Rasin riverfront · towards the city center', description: 'Traffic along the riverfront. Choose a prediction and compare it with the verified count.', streamType: 'hls', streamUrl: '/media/demo-vltava.m3u8', thumbnailUrl: '', sourceOwner: 'Sample camera', sourcePageUrl: '', termsUrl: '', usageNotes: 'Illustrated road scene. No live camera feed is connected in this preview.', isActive: true, createdAt: time(-1440), updatedAt: time(-60) },
  { id: 2, title: 'City arterial road', city: 'Brno', country: 'Czechia', locationLabel: 'Hradecka street · northern approach', description: 'Test a traffic prediction on a city arterial road.', streamType: 'hls', streamUrl: '/media/demo-brno.m3u8', thumbnailUrl: '', sourceOwner: 'Sample camera', sourcePageUrl: '', termsUrl: '', usageNotes: 'Sample data for design preview.', isActive: true, createdAt: time(-1440), updatedAt: time(-60) },
  { id: 3, title: 'Republic Square', city: 'Pilsen', country: 'Czechia', locationLabel: 'Eastern approach · 2 lanes', description: 'A small city intersection with traffic in both directions.', streamType: 'image', streamUrl: '/media/demo-plzen.jpg', thumbnailUrl: '', sourceOwner: 'Sample camera', sourcePageUrl: '', termsUrl: '', usageNotes: 'Sample data for design preview.', isActive: true, createdAt: time(-1440), updatedAt: time(-60) }
];
const markets: Market[] = [
  { id: 1, streamId: 1, streamTitle: streams[0].title, title: 'How many vehicles in 10 minutes?', threshold: 45, bettingClosesAt: time(9), windowStart: time(10), windowEnd: time(20), oddsOver: 1.85, oddsUnder: 1.95, status: 'open', createdAt: time(-10), updatedAt: time(-10) },
  { id: 2, streamId: 2, streamTitle: streams[1].title, title: 'Traffic on the northern approach', threshold: 60, bettingClosesAt: time(11), windowStart: time(12), windowEnd: time(22), oddsOver: 1.9, oddsUnder: 1.9, status: 'open', createdAt: time(-10), updatedAt: time(-10) },
  { id: 3, streamId: 1, streamTitle: streams[0].title, title: 'Completed interval — ready for verification', threshold: 40, bettingClosesAt: time(-31), windowStart: time(-30), windowEnd: time(-20), oddsOver: 1.9, oddsUnder: 1.9, status: 'open', createdAt: time(-40), updatedAt: time(-40) }
];
const metrics: StreamMetric[] = [12, 18, 21, 27, 32, 39, 44].map((count, i) => ({ id: i + 1, streamId: 1, source: 'manual', vehicleCount: count, intervalStart: time(-90 + i * 10), intervalEnd: time(-80 + i * 10), createdAt: time(-80 + i * 10) }));
const bets: Bet[] = [{ id: 1, userId: 1, marketId: 3, marketTitle: markets[2].title, streamTitle: streams[0].title, side: 'over', stakeCredits: 50, potentialPayoutCredits: 95, status: 'pending', createdAt: time(-40) }];
const ledger: Record<number, CreditLedgerEntry[]> = {
  1: [{ id: 1, reason: 'opening', deltaCredits: 1050, balanceAfter: 1050, createdAt: time(-1440) }, { id: 3, betId: 1, marketId: 3, reason: 'stake', deltaCredits: -50, balanceAfter: 1000, createdAt: time(-40) }],
  2: [{ id: 2, reason: 'opening', deltaCredits: 1000, balanceAfter: 1000, createdAt: time(-1440) }]
};
function addLedger(user: User, reason: 'stake' | 'payout' | 'refund', delta: number, bet: Bet): void { (ledger[user.id] ??= []).push({ id: Math.max(0, ...Object.values(ledger).flat().map((entry) => entry.id)) + 1, reason, deltaCredits: delta, balanceAfter: user.balanceCredits, betId: bet.id, marketId: bet.marketId, createdAt: time(0) }); }
const intents = new Map<string, { fingerprint: string; bet: Bet }>();
const previewSchedules = new Map<number, RoundScheduleSettings>();
function reject(status: number, message: string): never { throw new HttpErrorResponse({ status, error: { error: { message } } }); }
function requireUser(): User { return currentUser ?? reject(401, 'Sign in to the preview.'); }
function requireAdmin(): void { if (requireUser().role !== 'admin') reject(403, 'An administrator account is required.'); }
const copy = <T>(value: T): T => structuredClone(value);

function previewStakeVolume(): StakeVolumeSnapshot {
  const empty = (): StakeAmounts => ({ totalBetCount: 0, totalStakeCredits: 0, pendingBetCount: 0, pendingStakeCredits: 0, pendingOverBetCount: 0, pendingOverCredits: 0, pendingUnderBetCount: 0, pendingUnderCredits: 0, settledStakeCredits: 0, refundedStakeCredits: 0 });
  const add = (total: StakeAmounts, value: StakeAmounts): void => { for (const key of Object.keys(value) as Array<keyof StakeAmounts>) total[key] += value[key]; };
  const amounts = (marketId: number): StakeAmounts => {
    const total = empty();
    for (const bet of bets.filter((item) => item.marketId === marketId)) {
      total.totalBetCount++; total.totalStakeCredits += bet.stakeCredits;
      if (bet.status === 'pending') {
        total.pendingBetCount++; total.pendingStakeCredits += bet.stakeCredits;
        if (bet.side === 'over') { total.pendingOverBetCount++; total.pendingOverCredits += bet.stakeCredits; }
        else { total.pendingUnderBetCount++; total.pendingUnderCredits += bet.stakeCredits; }
      } else if (bet.status === 'void') total.refundedStakeCredits += bet.stakeCredits;
      else total.settledStakeCredits += bet.stakeCredits;
    }
    return total;
  };
  const snapshot: StakeVolumeSnapshot = { asOf: time(0), totals: empty(), historicalTotals: empty(), cameras: [] };
  for (const stream of streams) {
    const camera = { streamId: stream.id, title: stream.title, city: stream.city, isActive: stream.isActive, ...empty(), rounds: [] as StakeVolumeSnapshot['cameras'][number]['rounds'] };
    for (const market of markets.filter((item) => item.streamId === stream.id)) {
      const volume = amounts(market.id); add(camera, volume); add(snapshot.totals, volume);
      if (volume.pendingBetCount || (stream.isActive && market.status === 'open' && Date.parse(market.bettingClosesAt) > Date.parse(snapshot.asOf))) camera.rounds.push({ marketId: market.id, title: market.title, status: market.status, threshold: market.threshold, bettingClosesAt: market.bettingClosesAt, windowStart: market.windowStart, windowEnd: market.windowEnd, ...volume });
    }
    snapshot.cameras.push(camera);
  }
  snapshot.cameras.sort((a, b) => b.pendingStakeCredits - a.pendingStakeCredits || Number(b.isActive) - Number(a.isActive) || a.title.localeCompare(b.title));
  return snapshot;
}

export const previewInterceptor: HttpInterceptorFn = (request, next) => {
  if (!request.url.startsWith('/api/')) return next(request);
  return defer(() => {
    const path = request.url.split('?')[0];
    const body = request.body as Record<string, unknown> | null;
    let result: unknown;
    if (path === '/api/auth/login' && request.method === 'POST') {
      currentUser = users.find((user) => user.email === body?.['email']) ?? reject(401, 'Choose a sample profile.');
      result = { user: currentUser };
    } else if (path === '/api/auth/logout' && request.method === 'POST') { currentUser = undefined; result = { ok: true }; }
    else if (path === '/api/me/ledger') result = (ledger[requireUser().id] ?? []).slice().reverse();
    else if (path === '/api/me') result = requireUser();
    else if (path === '/api/streams') result = streams.filter((stream) => stream.isActive);
    else if (/^\/api\/streams\/\d+(\/markets|\/metrics)?$/.test(path)) {
      const id = Number(path.split('/')[3]);
      const stream = streams.find((item) => item.id === id && item.isActive) ?? reject(404, 'Camera unavailable.');
      const status = request.params.get('status') ?? 'open';
      result = path.endsWith('/markets') ? markets.filter((market) => market.streamId === id && market.status !== 'draft' && (!status || market.status === status)) : path.endsWith('/metrics') ? metrics.filter((metric) => metric.streamId === id).slice().reverse() : stream;
    } else if (path === '/api/bets/my') result = bets.filter((bet) => bet.userId === requireUser().id).slice().reverse();
    else if (path === '/api/bets' && request.method === 'POST') {
      const user = requireUser();
      const key = request.headers.get('Idempotency-Key');
      if (!key || !/^[a-zA-Z0-9_.-]{16,128}$/.test(key)) reject(400, 'Idempotency-Key is required.');
      const intentId = user.id + ':' + key;
      const fingerprint = JSON.stringify(body);
      const previous = intents.get(intentId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) reject(409, 'The repeated request has different parameters.');
        return of(new HttpResponse({ status: 200, body: copy({ bet: previous.bet, user }) })).pipe(delay(180));
      }
      const market = markets.find((item) => item.id === Number(body?.['marketId'])) ?? reject(404, 'Round not found.');
      const stake = Number(body?.['stakeCredits']);
      const side = body?.['side'];
      if (market.status !== 'open' || Date.now() >= Date.parse(market.bettingClosesAt) || Date.parse(market.windowStart) - Date.parse(market.bettingClosesAt) < 30_000) reject(400, 'Predictions are closed.');
      if (!streams.find((stream) => stream.id === market.streamId)?.isActive) reject(400, 'Camera disabled.');
      if (!Number.isInteger(stake) || stake < 1 || stake > 100000 || stake > user.balanceCredits) reject(400, 'Check your stake and available balance.');
      if (side !== 'over' && side !== 'under') reject(400, 'Choose an outcome.');
      const bet: Bet = { id: Math.max(0, ...bets.map((item) => item.id)) + 1, userId: user.id, marketId: market.id, marketTitle: market.title, streamTitle: market.streamTitle, side, stakeCredits: stake, potentialPayoutCredits: Math.round(stake * (side === 'over' ? market.oddsOver : market.oddsUnder)), status: 'pending', createdAt: time(0) };
      user.balanceCredits -= stake; addLedger(user, 'stake', -stake, bet); bets.push(bet); intents.set(intentId, { fingerprint, bet }); result = { bet, user };
    } else if (path.startsWith('/api/admin/')) {
      requireAdmin();
      if (/^\/api\/admin\/(preparation|source-health|round-review|audit|evaluation|operations)(\/|$)/.test(path)) reject(501, 'Counting preparation requires the real local Go API and PostgreSQL. The design preview has no camera evidence.');
      if (path === '/api/admin/stake-volume' && request.method === 'GET') result = previewStakeVolume();
      else if (path === '/api/admin/stake-volume/bets' && request.method === 'GET') {
        const streamId = Number(request.params.get('streamId'));
        const marketId = request.params.has('marketId') ? Number(request.params.get('marketId')) : undefined;
        const status = request.params.get('status') ?? 'pending';
        if (!Number.isInteger(streamId) || streamId <= 0 || !['pending', 'won', 'lost', 'void', 'all'].includes(status)) reject(400, 'Invalid prediction filters.');
        const stream = streams.find((item) => item.id === streamId) ?? reject(404, 'Camera not found.');
        if (marketId !== undefined && !markets.some((item) => item.id === marketId && item.streamId === streamId)) reject(404, 'Round not found on this camera.');
        const items = bets.filter((bet) => markets.some((market) => market.id === bet.marketId && market.streamId === streamId) && (marketId === undefined || bet.marketId === marketId) && (status === 'all' || bet.status === status)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id).map((bet) => ({ ...bet, streamId, streamTitle: stream.title, displayName: users.find((user) => user.id === bet.userId)?.displayName ?? 'Member', email: users.find((user) => user.id === bet.userId)?.email ?? '' }));
        const pageSize = Math.min(200, Math.max(1, Number(request.params.get('pageSize')) || 25));
        const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
        const page = Math.min(totalPages, Math.max(1, Number(request.params.get('page')) || 1));
        result = { asOf: time(0), streamId, marketId, status, items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, stakeCredits: items.reduce((sum, bet) => sum + bet.stakeCredits, 0), page, pageSize, totalPages };
      }
      else if (path === '/api/admin/users' && request.method === 'GET') {
        if (request.params.has('page') || request.params.has('pageSize') || request.params.has('q')) {
          const query = (request.params.get('q') ?? '').trim().toLocaleLowerCase('en');
          const items = users.filter((user) => !query || user.email.toLocaleLowerCase('en').includes(query) || user.displayName.toLocaleLowerCase('en').includes(query) || String(user.id) === query).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
          const pageSize = Math.min(200, Math.max(1, Number(request.params.get('pageSize')) || 25));
          const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
          const page = Math.min(totalPages, Math.max(1, Number(request.params.get('page')) || 1));
          result = { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, totalPages };
        } else result = users;
      }
      else if (path === '/api/admin/round-schedules' && request.method === 'GET') result = {
        asOf: time(0), schedules: streams.map((stream) => ({
          streamId: stream.id, streamTitle: stream.title, isActive: stream.isActive, supported: ['hls', 'youtube', 'mjpeg'].includes(stream.streamType),
          enabled: false, countingRule: 'Vehicle centers crossing the mid-frame line · both directions', threshold: 30, oddsOver: 1.9, oddsUnder: 1.9, entrySeconds: 30, leadSeconds: 120, countingSeconds: 30,
          ...previewSchedules.get(stream.id), nextRunAt: null, lastCheckedAt: null, lastMarketId: null,
          awaitingVerification: markets.filter((market) => market.streamId === stream.id && market.status === 'open' && Date.parse(market.windowEnd) <= Date.now()).length
        }))
      };
      else if (/^\/api\/admin\/round-schedules\/\d+$/.test(path) && request.method === 'PUT') {
        const stream = streams.find((item) => item.id === Number(path.split('/')[4])) ?? reject(404, 'Camera not found.');
        const settings = request.body as RoundScheduleSettings;
        if (settings.enabled && (!stream.isActive || !['hls', 'youtube', 'mjpeg'].includes(stream.streamType))) reject(409, 'Enable a continuous live camera first.');
        if (!settings.countingRule?.trim() || new TextEncoder().encode(settings.countingRule).length > 160 || /\p{Cc}/u.test(settings.countingRule) ||
          !Number.isInteger(settings.threshold) || settings.threshold < 0 || settings.threshold > 100000000 ||
          !Number.isInteger(settings.entrySeconds) || settings.entrySeconds < 30 || settings.entrySeconds > 3600 ||
          !Number.isInteger(settings.leadSeconds) || settings.leadSeconds < 30 || settings.leadSeconds > 3600 ||
          !Number.isInteger(settings.countingSeconds) || settings.countingSeconds < 30 || settings.countingSeconds > 3600 ||
          [settings.oddsOver, settings.oddsUnder].some((n) => !Number.isFinite(n) || n < 1 || n > 100 || Math.abs(n * 100 - Math.round(n * 100)) > 0.000001)) reject(400, 'Invalid automatic round settings.');
        previewSchedules.set(stream.id, copy(settings)); result = { saved: true };
      }
      else if (path === '/api/admin/streams' && request.method === 'GET') result = streams;
      else if (path === '/api/admin/streams' && request.method === 'POST') {
        const payload = request.body as StreamPayload;
        if (!payload.title?.trim() || !payload.city?.trim() || !payload.streamUrl?.trim()) reject(400, 'Complete the required camera fields.');
        const stream = { ...payload, id: Math.max(0, ...streams.map((item) => item.id)) + 1, createdAt: time(0), updatedAt: time(0) };
        streams.push(stream); result = stream;
      } else if (/^\/api\/admin\/streams\/\d+\/restore$/.test(path) && request.method === 'PATCH') {
        const stream = streams.find((item) => item.id === Number(path.split('/')[4])) ?? reject(404, 'Camera not found.');
        stream.isActive = true; stream.updatedAt = time(0); result = stream;
      } else if (/^\/api\/admin\/streams\/\d+$/.test(path) && request.method === 'DELETE') {
        const stream = streams.find((item) => item.id === Number(path.split('/')[4])) ?? reject(404, 'Camera not found.');
        stream.isActive = false; stream.updatedAt = time(0); result = { deleted: true };
      } else if (/^\/api\/admin\/streams\/\d+$/.test(path) && request.method === 'PUT') {
        const index = streams.findIndex((stream) => stream.id === Number(path.split('/')[4]));
        if (index < 0) reject(404, 'Camera not found.');
        streams[index] = { ...streams[index], ...(request.body as StreamPayload), updatedAt: time(0) }; result = streams[index];
      } else if (path === '/api/admin/markets' && request.method === 'GET') result = markets.slice().reverse();
      else if (path === '/api/admin/markets' && request.method === 'POST') {
        const payload = request.body as MarketPayload;
        const stream = streams.find((item) => item.id === payload.streamId && item.isActive) ?? reject(400, 'Select an active camera.');
        if (!['hls', 'youtube', 'mjpeg'].includes(stream.streamType)) reject(400, 'Prediction rounds require a continuous camera feed.');
        if (!payload.title?.trim() || !Number.isInteger(payload.threshold) || payload.threshold < 0 || payload.oddsOver < 1 || payload.oddsOver > 100 || payload.oddsUnder < 1 || payload.oddsUnder > 100) reject(400, 'Check the title, threshold and odds.');
        if (!(Date.parse(payload.windowEnd) > Date.parse(payload.windowStart)) || !(Date.parse(payload.windowStart) - Date.parse(payload.bettingClosesAt) >= 30_000)) reject(400, 'Predictions must close at least 30 seconds before counting starts.');
        if (payload.status === 'open' && Date.parse(payload.bettingClosesAt) <= Date.now()) reject(400, 'The deadline must be in the future.');
        const market: Market = { ...payload, id: Math.max(0, ...markets.map((item) => item.id)) + 1, streamTitle: stream.title, createdAt: time(0), updatedAt: time(0) };
        markets.push(market); result = market;
      } else if (/^\/api\/admin\/markets\/\d+\/void$/.test(path) && request.method === 'PATCH') {
        const market = markets.find((item) => item.id === Number(path.split('/')[4])) ?? reject(404, 'Round not found.');
        const reason = String(body?.['reason'] ?? '').trim();
        if ([...reason].length < 5 || [...reason].length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) reject(400, 'Enter a reason from 5 to 500 characters, without control characters.');
        if (market.status === 'settled') reject(409, 'A settled round cannot be voided.');
        if (market.status === 'void' && market.voidReason !== reason) reject(409, 'This round was already voided with a different reason.');
        if (market.status !== 'void') {
          market.status = 'void'; market.voidReason = reason; market.updatedAt = time(0);
          bets.filter((bet) => bet.marketId === market.id && bet.status === 'pending').forEach((bet) => {
            bet.status = 'void'; bet.settledAt = time(0);
            const owner = users.find((user) => user.id === bet.userId);
            if (owner) { owner.balanceCredits += bet.stakeCredits; addLedger(owner, 'refund', bet.stakeCredits, bet); }
          });
        }
        result = market;
      } else if (/^\/api\/admin\/markets\/\d+\/settle$/.test(path) && request.method === 'PATCH') {
        const market = markets.find((item) => item.id === Number(path.split('/')[4])) ?? reject(404, 'Round not found.');
        const count = Number(body?.['actualCount']);
        if (!Number.isInteger(count) || count < 0 || count > 100000000) reject(400, 'Enter a whole number from 0 to 100,000,000.');
        if (market.status !== 'open' || Date.parse(market.windowEnd) > Date.now()) reject(400, 'Settlement is available after the counting interval ends.');
        market.status = 'settled'; market.actualCount = count; market.updatedAt = time(0);
        bets.filter((bet) => bet.marketId === market.id && bet.status === 'pending').forEach((bet) => {
          bet.status = (bet.side === 'over' ? count > market.threshold : count <= market.threshold) ? 'won' : 'lost'; bet.settledAt = time(0);
          if (bet.status === 'won') { const owner = users.find((user) => user.id === bet.userId); if (owner) { owner.balanceCredits += bet.potentialPayoutCredits; addLedger(owner, 'payout', bet.potentialPayoutCredits, bet); } }
        });
        metrics.push({ id: metrics.length + 1, streamId: market.streamId, source: 'manual', vehicleCount: count, intervalStart: market.windowStart, intervalEnd: market.windowEnd, createdAt: time(0) }); result = market;
      } else if (path === '/api/admin/bets') result = bets.slice().reverse();
      else reject(404, 'This action is not supported in the design preview.');
    } else reject(404, 'This action is not supported in the design preview.');
    return of(new HttpResponse({ status: 200, body: copy(result) })).pipe(delay(180));
  });
};
