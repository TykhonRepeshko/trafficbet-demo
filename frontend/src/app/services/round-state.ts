import type { Market, TrafficStream } from '../models';

export type RoundPhase = 'open' | 'locked' | 'counting' | 'verifying' | 'settled' | 'void' | 'draft' | 'unavailable';

export const roundPhaseLabels: Record<RoundPhase, string> = {
  open: 'Predictions open', locked: 'Predictions closed', counting: 'Counting in progress',
  verifying: 'Awaiting verification', settled: 'Verified result', void: 'Voided · stakes refunded',
  draft: 'Draft', unavailable: 'Predictions unavailable'
};

export function roundPhase(market: Market, now: number): RoundPhase {
  if (market.status !== 'open') return ['settled', 'void', 'draft'].includes(market.status) ? market.status : 'unavailable';
  const close = Date.parse(market.bettingClosesAt), start = Date.parse(market.windowStart), end = Date.parse(market.windowEnd);
  if (![now, close, start, end].every(Number.isFinite) || start - close < 30_000 || end <= start) return 'unavailable';
  if (now < close) return 'open';
  if (now < start) return 'locked';
  if (now < end) return 'counting';
  return 'verifying';
}

export function acceptsPredictions(market: Market, now: number, stream?: TrafficStream): boolean {
  return !!stream?.isActive && ['hls', 'youtube', 'mjpeg'].includes(stream.streamType) && roundPhase(market, now) === 'open';
}
