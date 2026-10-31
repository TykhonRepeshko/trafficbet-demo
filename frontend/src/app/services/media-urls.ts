import { TrafficStream } from '../models';

// Never load arbitrary camera URLs in the browser. The Go gateway owns upstream access.
export function cameraGatewayUrl(stream: TrafficStream, raw: string, resource: 'index.m3u8' | 'clip.mp4' | 'snapshot' | 'mjpeg'): string {
  if (!Number.isSafeInteger(stream.id) || stream.id <= 0 || !raw) return '';
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin || url.username || url.password || url.search || url.hash || url.pathname !== `/api/media/streams/${stream.id}/${resource}`) return '';
    return url.href;
  } catch { return ''; }
}

export function cameraSnapshotUrl(stream: TrafficStream): string {
  return cameraGatewayUrl(stream, stream.thumbnailUrl || (stream.streamType === 'image' ? stream.streamUrl : ''), 'snapshot');
}

export function youtubeVideoId(raw: string): string {
  return /^https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})$/.exec(raw)?.[1] ?? '';
}
