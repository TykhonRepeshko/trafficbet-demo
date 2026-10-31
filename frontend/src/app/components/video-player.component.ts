import { DatePipe, NgIf } from '@angular/common';
import { Component, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild, inject } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import type Hls from 'hls.js';
import type { ErrorData, LevelUpdatedData } from 'hls.js';
import { environment } from '../../environments/environment';
import { CountingSnapshot, TrafficStream } from '../models';
import { cameraGatewayUrl, cameraSnapshotUrl, youtubeVideoId } from '../services/media-urls';
import { CountingOverlayComponent } from './counting-overlay.component';
import { CameraSceneComponent } from './camera-scene.component';

@Component({ selector: 'app-video-player', standalone: true, imports: [DatePipe, NgIf, CameraSceneComponent, CountingOverlayComponent], template: `
  <div class="camera-player">
    <div class="video-shell" #playerShell>
      <app-camera-scene *ngIf="preview" [variant]="stream.id"></app-camera-scene>
      <img *ngIf="!preview && !playing && poster && !posterFailed" class="video-poster" [src]="poster" alt="Latest available camera preview" referrerpolicy="no-referrer" (load)="posterLoaded($event)" (error)="posterFailed = true">
      <div *ngIf="!playing || preview" class="player-overlay" [class.plain-player]="!preview && (!poster || posterFailed)"><span class="player-symbol">{{ preview ? '▣' : '▷' }}</span><strong>{{ preview ? 'Sample location' : stream.streamType === 'image' ? 'Camera snapshots' : stream.streamType === 'mp4' ? 'Periodic camera clips' : 'Camera stream' }}</strong><p>{{ preview ? 'Illustrated road scene. This design preview does not contain live video.' : playable ? stream.streamType === 'youtube' ? 'Load the source operator’s YouTube player to watch the feed.' : stream.streamType === 'mp4' ? 'A short camera recording updated periodically by its operator. This is not a continuous live feed.' : stream.streamType === 'image' ? 'The image refreshes every 15 seconds.' : 'Open the camera feed. Playback timing depends on the source.' : 'A supported camera feed has not been connected yet.' }}</p><button *ngIf="!preview && playable" class="button primary" (click)="start()" type="button">{{ stream.streamType === 'image' ? 'View snapshots' : 'Watch camera' }}</button></div>
      <video #video *ngIf="playing && !preview && (stream.streamType === 'hls' || stream.streamType === 'mp4')" class="video-frame" controls controlsList="nofullscreen nodownload" [disablePictureInPicture]="true" muted playsinline [loop]="stream.streamType === 'mp4'" preload="metadata" (loadedmetadata)="updateResolution()" (resize)="updateResolution()" (loadeddata)="loaded()" (play)="playbackResumed()" (pause)="playbackPaused()" (error)="mediaError()"></video>
      <img *ngIf="playing && !preview && (stream.streamType === 'image' || stream.streamType === 'mjpeg') && imageUrl" class="video-frame" [src]="imageUrl" [alt]="stream.streamType === 'image' ? 'Refreshing camera snapshot' : 'MJPEG camera feed'" referrerpolicy="no-referrer" (load)="loaded()" (error)="mediaError()">
      <iframe *ngIf="playing && !preview && stream.streamType === 'youtube' && youtubeUrl" class="video-frame" [src]="youtubeUrl" title="Source operator camera player on YouTube" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen (load)="loaded()"></iframe>
      <app-counting-overlay *ngIf="!preview && !error && (playing ? !loading : !!poster && !posterFailed && posterWidth > 0)" [guide]="stream.countingGuide" [snapshot]="countingSnapshot" [mediaWidth]="playing ? mediaWidth : posterWidth" [mediaHeight]="playing ? mediaHeight : posterHeight"></app-counting-overlay>
      <button *ngIf="playing && !error" class="camera-fullscreen" type="button" (click)="toggleFullscreen(playerShell)" aria-label="Toggle fullscreen with counting line">⛶</button>
      <div class="media-loading" *ngIf="playing && loading && !error" role="status"><span class="spinner"></span> {{ recovering ? 'Reconnecting to camera…' : 'Connecting to camera…' }}</div>
      <div class="media-error" *ngIf="error" role="alert"><strong>Source temporarily unavailable</strong><span>{{ error }}</span><button class="button primary" type="button" (click)="retry()">Reconnect</button></div>
      <span class="video-label">CAM / {{ stream.id.toString().padStart(3, '0') }} <span>{{ preview ? 'SIMULATION' : playing ? stream.streamType === 'mp4' ? 'PERIODIC CLIP' : stream.streamType === 'image' ? 'SNAPSHOT' : stream.streamType === 'youtube' ? 'YOUTUBE' : stream.streamType === 'hls' && liveSourceState === 'live' && !error ? 'LIVE' : 'STREAM' : 'CAMERA' }}</span></span>
    </div>
    <div class="player-status" *ngIf="!preview && playable"><div><span class="dot" [class.orange]="!playing || !!error || loading || recovering || (stream.streamType === 'hls' && liveSourceState !== 'live')"></span><span>{{ stream.streamType === 'mp4' ? 'Periodic camera clips' : stream.streamType === 'image' ? 'Snapshots every 15 seconds' : stream.streamType === 'youtube' ? 'Source operator player' : stream.streamType === 'hls' ? liveSourceLabel : 'Camera video feed' }}<small *ngIf="lastLoaded && playing"> · loaded {{ lastLoaded | date:'HH:mm:ss' }}</small></span></div><button class="text-button" type="button" (click)="goLive()" *ngIf="playing && stream.streamType === 'hls' && liveSourceState === 'live' && !error" [disabled]="loading">Go to live</button><button class="text-button" type="button" (click)="retry()" *ngIf="playing && stream.streamType !== 'youtube'" [disabled]="loading">↻ Refresh</button></div>
    <p class="small-note player-note" *ngIf="!preview && playing && sourceResolution"><strong>Source resolution: {{ sourceResolution }}</strong>. Detail depends on the camera and the operator’s compression.</p>
    <p class="small-note player-note" *ngIf="!preview && stream.countingGuide">The turquoise line marks the configured road crossing. Draft and preview lines are labelled separately from published round rules. Camera movement can invalidate the line.</p>
    <p class="notice player-note" *ngIf="!preview && playing && mediaWidth && mediaHeight && stream.countingGuide && (mediaWidth / mediaHeight / (stream.countingGuide.width / stream.countingGuide.height) < 0.99 || mediaWidth / mediaHeight / (stream.countingGuide.width / stream.countingGuide.height) > 1.01)">The video shape differs from the calibrated reference. The counting line is hidden until the camera is checked.</p>
    <p class="small-note player-note" *ngIf="!preview && playing && stream.streamType === 'hls' && liveSourceState !== 'recording'">A live feed includes a playback buffer. Go to live returns to the latest available video; the source operator controls the camera and its timestamp.</p>
    <p class="notice player-note" *ngIf="!preview && playing && stream.streamType === 'hls' && liveSourceState === 'recording'">The source is marked as a recording rather than a live feed.</p>
    <p class="small-note player-note" *ngIf="!preview && stream.streamType === 'mp4'">This short recording repeats. We check for updates every 2 minutes. Check the timestamp in the video; this is not a continuous live feed.</p>
    <p class="small-note player-note" *ngIf="!preview && stream.streamType === 'youtube'">The source operator controls this feed and may pause it or change the view. Follow the live indicator in the YouTube player; a loaded player does not confirm a live broadcast.</p>
  </div>
` })
export class VideoPlayerComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) stream!: TrafficStream;
  @Input() countingSnapshot?: CountingSnapshot;
  mediaWidth = 0; mediaHeight = 0;
  posterWidth = 0; posterHeight = 0;
  posterLoaded(event: Event): void {
    const image = event.target as HTMLImageElement;
    this.posterWidth = image.naturalWidth; this.posterHeight = image.naturalHeight;
  }
  private sourceIdentity = '';
  async toggleFullscreen(shell: HTMLElement): Promise<void> {
    try { if (document.fullscreenElement === shell) await document.exitFullscreen(); else await shell.requestFullscreen(); } catch { /* Playback remains available when fullscreen is unsupported. */ }
  }
  private videoRef?: ElementRef<HTMLVideoElement>;
  @ViewChild('video') set video(ref: ElementRef<HTMLVideoElement> | undefined) {
    this.videoRef = ref;
    // The video is conditional: initialise playback only after Angular creates it.
    if (ref && this.playing && !this.error) void this.setup(this.generation);
  }
  get video(): ElementRef<HTMLVideoElement> | undefined { return this.videoRef; }
  private readonly sanitizer = inject(DomSanitizer);
  readonly preview = environment.preview;
  safeUrl = ''; poster = ''; posterFailed = false; imageUrl = ''; youtubeUrl?: SafeResourceUrl;
  playing = false; loading = false; error = ''; lastLoaded?: Date;
  sourceResolution = '';
  liveSourceState: 'checking' | 'live' | 'stalled' | 'recording' | 'native' = 'checking';
  private sourceIsLive = false; private lastSourceSequence?: number; private sourceAdvanced = false; private lastSourceChange = 0; private liveStaleAfterMs = 30_000;
  private hls?: Hls; private generation = 0; private setupGeneration = -1;
  recovering = false; coolingDown = false;
  private recoveryAttempts = 0; private mediaRecoveries = 0; private recoveryAction: 'network' | 'master' | 'media' = 'network';
  private recoveryFailure = ''; private lastRecoveryAt = 0; private outageStartedAt = 0;
  private playbackWanted = false; private mediaRestarting = false; private watchSuspended = true;
  private lastObservedPosition?: number; private lastObservedAt = 0; private lastPresentedFrames?: number;
  private lastPlaybackProgress = 0; private healthySince = 0; private healthyPlaybackSeconds = 0;
  private recoveryTimer?: number; private cooldownTimer?: number; private cooldownUntil = 0; private refreshTimer?: number; private loadingTimer?: number; private imageAbort?: AbortController; private imageObjectUrl = ''; private destroyed = false;
  get playable(): boolean { return !!this.safeUrl || !!this.youtubeUrl; }
  get liveSourceLabel(): string {
    if (!this.playing) return 'Camera video feed';
    if (this.coolingDown) return 'Camera unavailable · waiting to reconnect';
    if (this.error) return 'Camera video unavailable';
    if (this.recovering) return 'Reconnecting to live camera…';
    switch (this.liveSourceState) {
      case 'live': return 'Live feed · receiving new video';
      case 'stalled': return 'Source stopped updating';
      case 'recording': return 'Recorded source';
      case 'native': return 'Streaming · live status unavailable';
      default: return 'Checking live source…';
    }
  }

  ngOnChanges(changes?: SimpleChanges): void {
    if (changes && !changes['stream']) return;
    const identity = JSON.stringify([this.stream.id, this.stream.streamType, this.stream.streamUrl, this.stream.updatedAt]);
    if (this.sourceIdentity === identity) return;
    this.sourceIdentity = identity; this.mediaWidth = 0; this.mediaHeight = 0; this.posterWidth = 0; this.posterHeight = 0;
    this.dispose(); this.playing = false; this.loading = false; this.error = ''; this.safeUrl = ''; this.youtubeUrl = undefined; this.lastLoaded = undefined;
    this.poster = cameraSnapshotUrl(this.stream); this.posterFailed = false;
    const resources: Record<string, 'index.m3u8' | 'clip.mp4' | 'snapshot' | 'mjpeg'> = { hls: 'index.m3u8', mp4: 'clip.mp4', image: 'snapshot', mjpeg: 'mjpeg' };
    const resource = resources[this.stream.streamType];
    if (resource) this.safeUrl = cameraGatewayUrl(this.stream, this.stream.streamUrl, resource);
    if (this.stream.streamType === 'youtube') {
      const id = youtubeVideoId(this.stream.streamUrl);
      // This resource URL is constructed only from a strict video ID on a fixed trusted host.
      if (id) this.youtubeUrl = this.sanitizer.bypassSecurityTrustResourceUrl(`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&rel=0`);
    }
  }

  start(): void {
    if (!this.playable || this.preview || this.destroyed) return;
    this.dispose(); this.playing = true; this.error = ''; this.loading = true;
    this.recoveryAttempts = 0; this.mediaRecoveries = 0; this.playbackWanted = true;
    const generation = this.generation;
    this.loadingTimer = window.setTimeout(() => {
      if (generation !== this.generation || !this.loading || this.recovering) return;
      this.loadingTimer = undefined;
      const message = 'The camera did not provide playable video in time. Reconnect to try again.';
      // HLS may still be exhausting its own network retries at this deadline.
      if (this.stream.streamType === 'hls' && this.hls) this.scheduleRecovery('master', message, generation);
      else this.fail(message);
    }, 25_000);
    // Images do not need a video view; an existing video is reused on reconnect.
    if (this.video || this.stream.streamType === 'image' || this.stream.streamType === 'mjpeg') void this.setup(generation);
    if (this.stream.streamType === 'image') this.refreshTimer = window.setInterval(() => void this.loadSnapshot(this.generation), 15_000);
    if (this.stream.streamType === 'mp4') this.refreshTimer = window.setInterval(() => this.reloadClip(), 120_000);
    if (this.stream.streamType === 'mjpeg') this.refreshTimer = window.setInterval(() => this.reconnectMjpeg(), 7000);
    if (this.stream.streamType === 'hls') this.refreshTimer = window.setInterval(() => this.updateLiveHealth(), 1000);
  }

  retry(): void {
    this.dispose(); this.playing = false;
    const generation = this.generation;
    window.setTimeout(() => { if (generation === this.generation) this.start(); });
  }
  loaded(): void { if (this.error || this.destroyed) return; this.loading = false; this.lastLoaded = new Date(); this.updateResolution(); if (this.loadingTimer) window.clearTimeout(this.loadingTimer); }
  updateResolution(): void {
    if (!this.playing || this.error || this.destroyed) return;
    const video = this.video?.nativeElement;
    const width = video?.videoWidth ?? 0, height = video?.videoHeight ?? 0;
    this.mediaWidth = width; this.mediaHeight = height;
    // Read decoded dimensions: some operators advertise inaccurate master-playlist sizes.
    this.sourceResolution = Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
      ? `${width} × ${height}` : '';
  }
  playbackPaused(): void {
    // Recreating MediaSource can emit a pause event without a user pausing.
    if (this.mediaRestarting || this.destroyed) return;
    this.playbackWanted = false; this.watchSuspended = true; this.clearHealthyPlayback();
    if (this.recoveryTimer) window.clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined;
  }
  playbackResumed(): void {
    if (!this.playing || (this.error && !this.coolingDown) || this.destroyed) return;
    const wasPaused = !this.playbackWanted;
    this.playbackWanted = true; this.watchSuspended = true;
    if (this.coolingDown) { this.resumeAfterCooldown(); return; }
    if (wasPaused && this.recovering) this.scheduleRecovery('master', this.recoveryFailure, this.generation);
  }
  mediaError(): void {
    // Hls.js owns errors and recovery for its MediaSource attachment.
    if (this.hls || this.destroyed || !this.playing) return;
    const code = this.video?.nativeElement.error?.code;
    this.fail(code === 3 || code === 4 ? 'This browser could not decode the camera video. Try another camera or a current browser.' : 'The camera connection was interrupted. Reconnect to try again.');
  }
  ngOnDestroy(): void { this.destroyed = true; this.dispose(); }

  goLive(): void {
    const video = this.video?.nativeElement, hls = this.hls;
    if (!video || !hls || this.error || this.liveSourceState !== 'live' || !video.seekable.length) return;
    const start = video.seekable.start(video.seekable.length - 1), end = video.seekable.end(video.seekable.length - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const latest = Math.max(start, end - Math.min(3, (end - start) / 2));
    const sync = hls.liveSyncPosition;
    video.currentTime = sync !== null && Number.isFinite(sync) && sync >= start && sync < end ? Math.min(sync, latest) : latest;
    void video.play().catch(() => {});
  }

  private async setup(generation: number): Promise<void> {
    if (generation !== this.generation || !this.playing || this.destroyed || this.setupGeneration === generation) return;
    this.setupGeneration = generation;
    if (this.stream.streamType === 'image') { await this.loadSnapshot(generation); return; }
    if (this.stream.streamType === 'mjpeg') { this.imageUrl = this.safeUrl; return; }
    const video = this.video?.nativeElement;
    if (!video || !this.safeUrl) return;
    video.muted = true;
    if (this.stream.streamType === 'mp4') {
      video.src = this.safeUrl; video.load(); void video.play().catch(() => { /* Controls remain available when the browser requires another gesture. */ }); return;
    }
    try {
      const Hls = await this.loadHls();
      if (generation !== this.generation || !this.playing || video !== this.video?.nativeElement) return;
      // Chrome can report native HLS as "maybe" without playing this source.
      // Prefer hls.js / MediaSource and use native HLS only as a fallback.
      if (!Hls.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          this.liveSourceState = 'native';
          video.src = this.safeUrl; video.load(); void video.play().catch(() => {}); return;
        }
        this.fail('This browser does not support HLS playback. Please use a current browser.'); return;
      }
      this.hls = new Hls({ lowLatencyMode: true, liveDurationInfinity: true, enableWorker: false, xhrSetup: (xhr, rawUrl) => {
        let url: URL;
        try { url = new URL(rawUrl, window.location.origin); }
        catch { this.fail('The camera returned an invalid media address. Choose another camera.'); throw new Error('Invalid media resource address'); }
        if (url.origin !== window.location.origin || !url.pathname.startsWith(`/api/media/streams/${this.stream.id}/`) || url.username || url.password || url.hash || url.search) {
          this.fail('The camera returned an invalid media address. Choose another camera.'); throw new Error('Invalid media resource address');
        }
        xhr.withCredentials = false;
      } });
      this.hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal && generation === this.generation) this.hlsError(data, generation); });
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (generation !== this.generation) return;
        // Reloading a failed initial master does not always recreate MediaSource.
        this.mediaRestarting = false;
        if (this.playbackWanted && !this.error) void video.play().catch(() => {});
      });
      this.hls.on(Hls.Events.MEDIA_DETACHING, () => { if (generation === this.generation) this.mediaRestarting = true; });
      this.hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        if (generation !== this.generation) return;
        const resume = this.mediaRestarting && this.playbackWanted; this.mediaRestarting = false;
        if (resume && !this.error) void video.play().catch(() => {});
      });
      this.hls.on(Hls.Events.LEVEL_UPDATED, (_, data) => { if (generation === this.generation) this.sourceUpdated(data); });
      this.hls.loadSource(this.safeUrl); this.hls.attachMedia(video);
    } catch { if (generation === this.generation) this.fail('The video player could not start. Reconnect to try again.'); }
  }

  private async loadHls(): Promise<typeof Hls> { return (await import('hls.js')).default; }

  private sourceUpdated({ details }: LevelUpdatedData): void {
    this.sourceIsLive = details.live;
    if (!details.live) {
      this.fail('The camera source has ended and is marked as a recording. Choose an active live camera.');
      this.liveSourceState = 'recording'; return;
    }
    const sequence = details.endSN;
    if (!Number.isSafeInteger(sequence) || sequence < 0) return;
    const now = Date.now();
    if (this.lastSourceSequence === undefined || sequence < this.lastSourceSequence) {
      this.sourceAdvanced = false; this.lastSourceChange = now;
    } else if (sequence > this.lastSourceSequence) {
      this.sourceAdvanced = true; this.lastSourceChange = now;
    }
    this.lastSourceSequence = sequence;
    const target = Number.isFinite(details.targetduration) && details.targetduration > 0 && details.targetduration <= 3600 ? details.targetduration : 10;
    this.liveStaleAfterMs = Math.max(30_000, target * 3000);
    this.updateLiveHealth(now);
  }

  private updateLiveHealth(now = Date.now()): void {
    if (this.coolingDown) { this.resumeAfterCooldown(now); return; }
    if (!this.playing || this.error || this.destroyed) return;
    if (this.sourceIsLive && this.lastSourceSequence !== undefined) this.liveSourceState = now - this.lastSourceChange > this.liveStaleAfterMs ? 'stalled' : this.sourceAdvanced ? 'live' : 'checking';
    const video = this.video?.nativeElement;
    if (!this.hls || !video) return;
    if (!this.playbackWanted || (typeof document !== 'undefined' && document.hidden) || video.seeking || (video.paused && !this.loading && !this.mediaRestarting)) {
      this.watchSuspended = true; this.clearHealthyPlayback(); return;
    }
    if (this.watchSuspended) {
      this.watchSuspended = false; this.lastPlaybackProgress = now; this.lastObservedAt = now;
      this.lastObservedPosition = video.currentTime; this.lastPresentedFrames = this.presentedFrames(video); this.clearHealthyPlayback();
      // Resuming a paused/background tab gets a fresh grace period.
      if (this.recovering) this.lastRecoveryAt = now;
      return;
    }
    const elapsed = (now - this.lastObservedAt) / 1000, advanced = video.currentTime - (this.lastObservedPosition ?? video.currentTime);
    const frames = this.presentedFrames(video), framesAdvanced = frames === undefined || this.lastPresentedFrames === undefined || frames > this.lastPresentedFrames;
    const progressed = elapsed > 0 && elapsed <= 5 && advanced > 0.05 && advanced <= 5 && framesAdvanced;
    this.lastObservedAt = now; this.lastObservedPosition = video.currentTime; this.lastPresentedFrames = frames;
    if (progressed) {
      this.lastPlaybackProgress = now;
      // A manifest or buffered old video alone must not replenish the retry budget.
      const freshSource = this.liveSourceState === 'live' && (!this.recovering || this.lastSourceChange > this.outageStartedAt);
      if (freshSource) {
        if (!this.healthySince) this.healthySince = now;
        this.healthyPlaybackSeconds += Math.min(elapsed, advanced);
        if (now - this.healthySince >= 10_000 && this.healthyPlaybackSeconds >= 8) {
          this.recoveryAttempts = 0; this.mediaRecoveries = 0; this.recovering = false; this.loading = false;
          if (this.recoveryTimer) window.clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined;
        }
      } else this.clearHealthyPlayback();
    } else if (elapsed > 0) this.clearHealthyPlayback();
    const retryWait = Math.max(20_000, Math.min(60_000, this.liveStaleAfterMs * 2 / 3));
    if (this.recovering) {
      if (!this.recoveryTimer && now - this.lastRecoveryAt >= retryWait) this.scheduleRecovery('master', this.recoveryFailure, this.generation, now);
    } else if (this.liveSourceState === 'stalled') {
      this.scheduleRecovery('master', 'The live camera stopped updating. Reconnect to try again.', this.generation, now);
    } else if (this.lastLoaded && now - this.lastPlaybackProgress >= 20_000) {
      this.scheduleRecovery('master', 'The camera video stopped playing. Reconnect to try again.', this.generation, now);
    }
  }

  private hlsError(data: ErrorData, generation: number): void {
    if (!this.hls) return;
    if (data.type === 'networkError') {
      const status = data.response?.code;
      const code = status && Number.isInteger(status) && status >= 400 && status <= 599 ? ` (HTTP ${status})` : '';
      const message = `The camera service could not deliver the video${code}. Reconnect to try again.`;
      if (status && [400, 401, 403, 405, 422].includes(status)) { this.fail(message); return; }
      const master = data.details === 'manifestLoadError' || data.details === 'manifestLoadTimeOut' || status === 404 || status === 410;
      this.scheduleRecovery(master ? 'master' : 'network', message, generation);
    } else if (data.type === 'mediaError') {
      const message = 'The camera video could not be decoded. Try reconnecting or choose another camera.';
      if (['manifestParsingError', 'manifestIncompatibleCodecsError', 'levelParsingError', 'bufferIncompatibleCodecsError'].includes(data.details)) { this.fail(message); return; }
      this.scheduleRecovery('media', message, generation);
    } else this.fail('The camera returned video that the player could not use. Reconnect to try again.');
  }

  private scheduleRecovery(action: 'network' | 'master' | 'media', message: string, generation: number, now = Date.now()): void {
    const hls = this.hls;
    if (!hls || generation !== this.generation || this.error || !this.playing || this.destroyed) return;
    if (!this.recovering) { this.recovering = true; this.outageStartedAt = now; this.lastRecoveryAt = now; }
    this.recoveryFailure = message; this.clearHealthyPlayback();
    // Prefer decoder repair over a fresh master, and a fresh master over resume.
    if (action === 'media' || this.recoveryAction === 'network') this.recoveryAction = action;
    if (this.loadingTimer) window.clearTimeout(this.loadingTimer); this.loadingTimer = undefined;
    if (action === 'media' && this.mediaRecoveries >= 2) { this.fail(message); return; }
    if (this.recoveryAttempts >= 5) { this.beginCooldown(message, generation, now); return; }
    if (this.recoveryTimer || !this.playbackWanted || (typeof document !== 'undefined' && document.hidden)) return;
    this.loading = true;
    const delay = [1000, 2000, 4000, 8000, 15_000][this.recoveryAttempts];
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = undefined;
      if (generation !== this.generation || hls !== this.hls || !this.playing || this.destroyed || !this.playbackWanted || (typeof document !== 'undefined' && document.hidden)) return;
      this.recoveryAttempts++; this.lastRecoveryAt = Date.now();
      // A retried fragment may already have left the provider's short window.
      const next = this.recoveryAction === 'network' && this.recoveryAttempts > 1 ? 'master' : this.recoveryAction; this.recoveryAction = 'network';
      try {
        if (next === 'master') hls.loadSource(this.safeUrl);
        else if (next === 'media') { this.mediaRecoveries++; hls.recoverMediaError(); }
        else hls.startLoad();
      } catch { this.fail(message); }
    }, delay);
  }

  private beginCooldown(message: string, generation: number, now: number): void {
    if (this.coolingDown || !this.hls || generation !== this.generation) return;
    if (this.recoveryTimer) window.clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined;
    this.coolingDown = true; this.cooldownUntil = now + 60_000; this.loading = false; this.mediaRestarting = false;
    this.error = `${message.replace(/ Reconnect to try again\.$/, '')} We will retry automatically after 60 seconds while this tab is active. You can also reconnect now.`;
    this.hls.stopLoad(); this.clearHealthyPlayback(); this.watchSuspended = true;
    this.cooldownTimer = window.setTimeout(() => {
      this.cooldownTimer = undefined;
      if (generation === this.generation && !this.destroyed) this.resumeAfterCooldown();
    }, 60_000);
  }

  private resumeAfterCooldown(now = Date.now()): void {
    if (!this.coolingDown || this.destroyed || !this.playing || !this.hls || now < this.cooldownUntil || !this.playbackWanted || (typeof document !== 'undefined' && document.hidden)) return;
    if (this.cooldownTimer) window.clearTimeout(this.cooldownTimer); this.cooldownTimer = undefined;
    this.coolingDown = false; this.error = ''; this.recoveryAttempts = 0; this.recoveryAction = 'network'; this.lastRecoveryAt = now;
    // A long network outage replenishes only network attempts, never failed decoder repairs.
    this.scheduleRecovery('master', this.recoveryFailure, this.generation, now);
  }

  private presentedFrames(video: HTMLVideoElement): number | undefined {
    const quality = video.getVideoPlaybackQuality?.();
    const frames = quality ? quality.totalVideoFrames - quality.droppedVideoFrames : undefined;
    return frames !== undefined && Number.isFinite(frames) ? frames : undefined;
  }

  private clearHealthyPlayback(): void { this.healthySince = 0; this.healthyPlaybackSeconds = 0; }

  private fail(message: string): void { this.loading = false; this.error = message; this.dispose(); }

  private reloadClip(): void {
    if (!this.playing || this.error || this.stream.streamType !== 'mp4' || !this.video) return;
    this.video.nativeElement.load(); void this.video.nativeElement.play().catch(() => {});
  }

  private reconnectMjpeg(): void {
    if (!this.playing || this.error || this.stream.streamType !== 'mjpeg') return;
    const generation = this.generation; this.imageUrl = '';
    // Gateway connections are deliberately bounded. A fresh element reconnects to its no-store URL.
    window.setTimeout(() => { if (generation === this.generation && this.playing) this.imageUrl = this.safeUrl; });
  }

  private async loadSnapshot(generation: number): Promise<void> {
    if (!this.safeUrl || this.imageAbort) return;
    const controller = new AbortController(); this.imageAbort = controller;
    const abortTimer = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(this.safeUrl, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      if (!response.ok || !/^image\/(jpeg|png|webp)(;|$)/i.test(response.headers.get('Content-Type') ?? '')) throw new Error('Snapshot unavailable');
      const blob = await response.blob();
      if (generation !== this.generation || !this.playing) return;
      if (this.imageObjectUrl) URL.revokeObjectURL(this.imageObjectUrl);
      this.imageObjectUrl = URL.createObjectURL(blob); this.imageUrl = this.imageObjectUrl;
    } catch { if (generation === this.generation && this.playing) this.mediaError(); }
    finally { window.clearTimeout(abortTimer); if (this.imageAbort === controller) this.imageAbort = undefined; }
  }

  private dispose(): void {
    this.generation++; this.hls?.destroy(); this.hls = undefined;
    this.sourceResolution = '';
    this.setupGeneration = -1;
    this.recovering = false; this.coolingDown = false; this.cooldownUntil = 0; this.recoveryAction = 'network'; this.recoveryFailure = ''; this.playbackWanted = false; this.mediaRestarting = false; this.watchSuspended = true;
    this.lastObservedPosition = undefined; this.lastObservedAt = 0; this.lastPresentedFrames = undefined; this.lastPlaybackProgress = 0; this.clearHealthyPlayback();
    this.liveSourceState = 'checking'; this.sourceIsLive = false; this.sourceAdvanced = false; this.lastSourceSequence = undefined; this.lastSourceChange = 0;
    this.video?.nativeElement.pause();
    if (this.recoveryTimer) window.clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined;
    if (this.cooldownTimer) window.clearTimeout(this.cooldownTimer); this.cooldownTimer = undefined;
    if (this.refreshTimer) window.clearInterval(this.refreshTimer); this.refreshTimer = undefined;
    if (this.loadingTimer) window.clearTimeout(this.loadingTimer); this.loadingTimer = undefined;
    this.imageAbort?.abort(); this.imageAbort = undefined;
    if (this.imageObjectUrl) URL.revokeObjectURL(this.imageObjectUrl); this.imageObjectUrl = ''; this.imageUrl = '';
  }
}
