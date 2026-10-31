import { HttpErrorResponse } from '@angular/common/http';
export function apiError(error: unknown, fallback = 'The request could not be completed. Please try again.'): string {
  if (!(error instanceof HttpErrorResponse)) return fallback;
  if (error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504) return 'The service is unavailable. Please try again in a moment.';
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) return 'You do not have permission to perform this action.';
  if (error.status === 429) return 'Too many requests. Please wait a moment.';
  return error.error?.error?.message || fallback;
}
export const betLabels: Record<string, string> = { pending: 'Awaiting count', won: 'Won', lost: 'Lost', void: 'Refunded' };
export const marketLabels: Record<string, string> = { draft: 'Draft', open: 'Open', settled: 'Settled', void: 'Voided' };
