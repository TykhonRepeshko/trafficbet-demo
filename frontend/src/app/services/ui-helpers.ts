import { HttpErrorResponse } from '@angular/common/http';
import type { Bet } from '../models';
export function predictionLabel(bet: Bet): string { return bet.side === 'range' ? `${bet.rangeMin}–${bet.rangeMax} vehicles (inclusive)` : bet.side === 'over' ? 'Over the threshold' : 'Under or equal to the threshold'; }
export function apiError(error: unknown, fallback = 'The request could not be completed. Please try again.'): string {
  if (!(error instanceof HttpErrorResponse)) return fallback;
  if (error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504) return 'The service is unavailable. Please try again in a moment.';
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) return 'You do not have permission to perform this action.';
  if (error.status === 429) return 'Too many requests. Please wait a moment.';
  return error.error?.error?.message || fallback;
}
export function voidReasonLabel(reason: string | undefined): string {
  const text = reason ?? '';
  if (/camera_moved/.test(text)) return 'Refunded: the camera view changed during the round.';
  if (/incomplete_coverage|decode_failed|no_frames/.test(text)) return 'Refunded: the video had gaps during the round.';
  if (/no_capture_clock|camera_unavailable|clock/.test(text)) return 'Refunded: the camera’s clock couldn’t be verified.';
  if (/legacy_round/.test(text)) return 'Refunded: the round was published before automatic counting was set up.';
  if (/expired/.test(text)) return 'Refunded: the automatic count wasn’t ready in time.';
  return text ? `Refunded: ${text}` : 'Refunded: the round was cancelled.';
}
export const betLabels: Record<string, string> = { pending: 'Awaiting count', won: 'Won', lost: 'Lost', void: 'Refunded' };
export const marketLabels: Record<string, string> = { draft: 'Draft', open: 'Open', settled: 'Settled', void: 'Voided' };
