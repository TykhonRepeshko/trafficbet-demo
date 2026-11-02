import type { LiveRound, Market, RangeQuote, TrafficStream } from '../models';

/** Largest count the API accepts; the last ready-made option is open-ended up to it. */
export const OPEN_ENDED_MAX = 100000000;
/** A round is offered only if the player still has time to read the options and confirm. */
export const MIN_ENTRY_MS = 12_000;

export type LivePhase = 'waiting' | 'counting' | 'checking' | 'result';

export function rangeLabel(quote: Pick<RangeQuote, 'rangeMin' | 'rangeMax'>): string {
  if (quote.rangeMax >= OPEN_ENDED_MAX) return `${quote.rangeMin}+`;
  return quote.rangeMin === quote.rangeMax ? `${quote.rangeMin}` : `${quote.rangeMin}–${quote.rangeMax}`;
}

/** Cameras the AI can count right now: active HLS feeds that automation has not paused. */
export function playableStreams(streams: readonly TrafficStream[]): TrafficStream[] {
  return streams.filter((stream) => stream.isActive && stream.streamType === 'hls' && !stream.automationPause);
}

/** The nearest round that still accepts predictions long enough and has a frozen AI counting line. */
export function pickMarket(markets: readonly Market[], now: number): Market | undefined {
  return [...markets]
    .filter((market) => market.status === 'open' && market.countingRules?.mode === 'versioned' && Date.parse(market.bettingClosesAt) - now >= MIN_ENTRY_MS)
    .sort((a, b) => Date.parse(a.bettingClosesAt) - Date.parse(b.bettingClosesAt))[0];
}

export function randomItem<T>(items: readonly T[], random: () => number = Math.random): T | undefined {
  return items.length ? items[Math.min(items.length - 1, Math.floor(random() * items.length))] : undefined;
}

/**
 * Where the round is from the viewer's point of view. With `displayed` (capture time of the frame on screen)
 * the phases follow the video, so the count ticks when a vehicle crosses on screen; otherwise wall-clock time.
 * A settled result is revealed once the video has shown the whole window (or 90 s later at the latest).
 */
export function livePhase(round: Pick<LiveRound, 'status' | 'windowStart' | 'windowEnd'>, displayed: number | null, now: number): LivePhase {
  const start = Date.parse(round.windowStart) / 1000, end = Date.parse(round.windowEnd) / 1000;
  const t = displayed ?? now / 1000;
  if (round.status === 'void') return 'result';
  if (round.status === 'settled' && (displayed === null || t >= end || now / 1000 > end + 90)) return 'result';
  if (t < start) return 'waiting';
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
