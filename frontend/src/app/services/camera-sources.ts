import type { TrafficStream } from '../models';

/** One public card per reviewed source; admin history keeps the original IDs. */
export function uniqueCameraSources(streams: readonly TrafficStream[]): TrafficStream[] {
  const seen = new Set<string>();
  return streams.filter(stream => {
    let key = stream.countingGuide?.sourceFingerprint;
    if (!key) {
      const raw = stream.sourcePageUrl || stream.streamUrl;
      try { key = raw ? new URL(raw, 'http://localhost').href : undefined; } catch { /* keep unknown sources separate */ }
    }
    key = key || `id:${stream.id}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
