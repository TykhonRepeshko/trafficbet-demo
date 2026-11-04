import type { LiveCrossing, LiveHighlightFrame, LiveVehicleBox, LiveRound, Market, RangeQuote, TrafficStream } from '../models';

/** Largest custom count accepted by the API. */
export const OPEN_ENDED_MAX = 100000000;
/** A round is offered only if the player still has time to read the options and confirm. */
export const MIN_ENTRY_MS = 12_000;

export type LivePhase = 'waiting' | 'syncing' | 'counting' | 'checking' | 'result';

export function rangeLabel(quote: Pick<RangeQuote, 'rangeMin' | 'rangeMax'>): string {
  if (quote.rangeMax >= OPEN_ENDED_MAX) return `${quote.rangeMin}+`;
  return quote.rangeMin === quote.rangeMax ? `${quote.rangeMin}` : `${quote.rangeMin}–${quote.rangeMax}`;
}

/** Cameras the AI can count right now: active HLS feeds that automation has not paused. */
export function playableStreams(streams: readonly TrafficStream[]): TrafficStream[] {
  return streams.filter((stream) => stream.isActive && stream.streamType === 'hls' && !stream.automationPause);
}

/** The nearest round that still accepts predictions long enough and has a frozen AI counting line. */
export function pickMarket(markets: readonly Market[], now: number, requireVersioned = true): Market | undefined {
  return [...markets]
    .filter((market) => market.status === 'open' && (!requireVersioned || market.countingRules?.mode === 'versioned') && Date.parse(market.bettingClosesAt) - now >= MIN_ENTRY_MS)
    .sort((a, b) => Date.parse(a.bettingClosesAt) - Date.parse(b.bettingClosesAt))[0];
}

export function randomItem<T>(items: readonly T[], random: () => number = Math.random): T | undefined {
  return items.length ? items[Math.min(items.length - 1, Math.floor(random() * items.length))] : undefined;
}

/**
 * The scheduled start follows wall-clock time; a delayed feed is a separate syncing phase.
 * Once the video reaches the window, counting follows its capture time so crossings stay in sync.
 * A settled result is revealed once the video has shown the whole window (or 90 s later at the latest).
 */
export function livePhase(round: Pick<LiveRound, 'status' | 'windowStart' | 'windowEnd'>, displayed: number | null, now: number): LivePhase {
  const start = Date.parse(round.windowStart) / 1000, end = Date.parse(round.windowEnd) / 1000;
  const t = displayed ?? now / 1000;
  if (round.status === 'void') return 'result';
  if (round.status === 'settled' && (displayed === null || t >= end || now / 1000 > end + 90)) return 'result';
  if (now / 1000 < start) return 'waiting';
  if (t < start) return 'syncing';
  if (t < end) return 'counting';
  return 'checking';
}

/** Vehicles counted so far, limited to crossings that have already happened in the frame on screen. */
export function liveCount(round: LiveRound | undefined, displayed: number | null): number {
  if (!round) return 0;
  if (round.status === 'settled' && round.actualCount !== undefined && displayed === null) return round.actualCount;
  const live = round.live;
  if (!live) return 0;
  return displayed === null ? live.vehicleCount : live.crossings.filter((crossing) => crossing.at <= displayed).length;
}

/**
 * True while the AI has not yet analysed the moment shown on screen, so the visible count may still rise.
 * Avoids presenting a confident "0" while the analysis is a few seconds behind the video.
 */
export function aiBehind(round: LiveRound | undefined, displayed: number | null, now: number, phase: LivePhase): boolean {
  if (phase !== 'counting' && phase !== 'checking') return false;
  if (round && round.status !== 'open') return false;
  const live = round?.live;
  if (!live) return true;
  const end = Date.parse(round!.windowEnd) / 1000;
  const shown = Math.min(displayed ?? now / 1000 - 2, end);
  return live.processedUntil + 0.25 < shown;
}

export function payoutFor(stake: number, odds: number): number {
  return Number.isFinite(stake) && Number.isFinite(odds) ? Math.floor(stake * odds) : 0;
}

export function mmss(seconds: number): string {
  const value = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(value / 60)}:${(value % 60).toString().padStart(2, '0')}`;
}

/** Half-second pulse after the measured crossing, aligned to capture time and observed positions. */
export function countedVehicleBoxes(frames: readonly LiveHighlightFrame[] | undefined, displayed: number | null, crossings?: readonly LiveCrossing[]): LiveVehicleBox[] {
  if (!frames?.length || !crossings?.length || displayed === null || !Number.isFinite(displayed)) return [];
  const crossed = new Map<number, number>();
  for (const c of crossings) {
    if (Number.isSafeInteger(c.trackId) && c.trackId! >= 0 && Number.isFinite(c.at))
      crossed.set(c.trackId!, Math.min(c.at, crossed.get(c.trackId!) ?? Infinity));
  }
  const before = [...frames].reverse().find(f => Number.isFinite(f.at) && f.at <= displayed);
  if (!before) return [];
  const valid = (b: LiveVehicleBox) => Number.isSafeInteger(b.trackId) && b.trackId >= 0 &&
    [b.x,b.y,b.width,b.height].every(Number.isFinite) && b.x >= 0 && b.y >= 0 && b.width > 0 && b.height > 0 && b.x+b.width <= 1.001 && b.y+b.height <= 1.001;
  const after = frames.find(f => Number.isFinite(f.at) && f.at > displayed);
  return before.boxes.filter(valid).flatMap(box => {
    const at = crossed.get(box.trackId);
    if (at === undefined || displayed < at || displayed >= at + 0.5) return [];
    const next = after?.boxes.find(b => b.trackId === box.trackId && valid(b));
    if (next && after && after.at-before.at <= 0.31) {
      const r = (displayed-before.at)/(after.at-before.at);
      return [{ trackId:box.trackId, x:box.x+(next.x-box.x)*r, y:box.y+(next.y-box.y)*r,
        width:box.width+(next.width-box.width)*r, height:box.height+(next.height-box.height)*r }];
    }
    return displayed-before.at <= 0.25 ? [box] : [];
  });
}

/** Observe the current AI window, independently of which future round accepts bets. */
export function pickObservedMarket(markets: readonly Market[], streamId: number, now: number, sourceFingerprint?: string): Market | undefined {
  const eligible = markets.filter(m => m.streamId === streamId && m.status === 'open' && m.countingRules?.mode === 'versioned' &&
    (!sourceFingerprint || m.countingRules.sourceFingerprint === sourceFingerprint) &&
    Number.isFinite(Date.parse(m.windowStart)) && Number.isFinite(Date.parse(m.windowEnd)) && Date.parse(m.windowEnd)>Date.parse(m.windowStart));
  return eligible.filter(m => Date.parse(m.windowStart)<=now && Date.parse(m.windowEnd)>=now-90_000)
    .sort((a,b)=>Date.parse(b.windowStart)-Date.parse(a.windowStart))[0]
    ?? eligible.filter(m=>Date.parse(m.windowStart)>now).sort((a,b)=>Date.parse(a.windowStart)-Date.parse(b.windowStart))[0];
}
