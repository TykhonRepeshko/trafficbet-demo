import { NgIf } from '@angular/common';
import { Component, DestroyRef, OnDestroy, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { timeout } from 'rxjs';
import { VideoPlayerComponent } from '../components/video-player.component';
import { TrafficStream } from '../models';
import { ApiService } from '../services/api.service';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-streaming-lab', standalone: true,
  imports: [NgIf, RouterLink, VideoPlayerComponent],
  template: `
    <div class="page-heading"><div><span class="eyebrow">OPERATOR EXPERIMENT</span><h1>Streaming lab<span class="heading-dot">.</span></h1><p>A separate live source for testing transport and playback.</p></div><a routerLink="/admin" class="button compact">← Back to admin</a></div>
    <div class="notice lab-notice"><strong>Protocol test only</strong><p>Cala Bona harbour is a fixed public camera with live WebRTC and HLS delivery. Its harbour view is unsuitable for reliable car counting. It is separate from the five road cameras and has no prediction rounds.</p></div>
    <div class="lab-grid">
      <article class="lab-panel"><div class="lab-panel-heading"><span class="eyebrow">EXPERIMENTAL SOURCE</span><span class="tag neutral">External player</span></div><h2>Cala Bona harbour</h2><p class="muted">Mallorca, Spain · Hotel Cala Bona / RTSP.ME</p>
        <div class="lab-video">
          <iframe *ngIf="playing" src="https://rtsp.me/embed/5tYtr3zD/" title="Public Cala Bona harbour live camera by RTSP.ME" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-presentation" allow="autoplay; fullscreen; camera 'none'; microphone 'none'; geolocation 'none'" allowfullscreen></iframe>
          <div *ngIf="!playing" class="lab-placeholder"><span aria-hidden="true">▷</span><strong>{{ preview ? 'Design preview' : presenceExpired ? 'Continue the viewing test' : 'Start the live camera' }}</strong><p>{{ preview ? 'Open the connected project to run a live camera test.' : 'The external provider receives your IP address when its player loads. No camera or microphone access is granted.' }}</p><button class="button primary" type="button" (click)="start()" [disabled]="preview">{{ presenceExpired ? 'Continue test' : 'Load live test' }}</button></div>
        </div>
        <div class="lab-controls"><strong>{{ playing ? 'Provider player loaded' : 'Player stopped' }}</strong><button *ngIf="playing" class="button compact" type="button" (click)="stop()">Stop test</button></div>
        <p class="small-note">The provider prefers WebRTC and may fall back to HLS. This page cannot read the selected protocol inside the external player; a loaded frame does not prove playback. The lab stops after 10 minutes and requires an explicit continuation.</p>
        <p class="small-note">Source: <a href="https://www.calabonahotel.com/en/webcam/" target="_blank" rel="noopener noreferrer">Hotel Cala Bona ↗</a> · <a href="https://rtsp.me/en/webrtc-vs-hls.html" target="_blank" rel="noopener noreferrer">Provider protocol details ↗</a></p>
      </article>
      <article class="lab-panel"><div class="lab-panel-heading"><span class="eyebrow">CURRENT APPLICATION</span><span class="tag neutral">HLS reference</span></div><h2>{{ reference?.title || 'Road camera' }}</h2><p class="muted">Original source through the project media gateway</p>
        <app-video-player *ngIf="reference" [stream]="reference"></app-video-player>
        <p *ngIf="referenceFailed" class="notice" role="alert">The reference camera could not be loaded. Return to the camera catalog and try again.</p>
        <p class="small-note">Different cameras have different source delays. These two views let you inspect playback, but are not a measurement of protocol latency. The benchmark compares identical frames from the experimental camera's WebRTC and HLS feeds.</p>
      </article>
    </div>
    <section class="lab-panel lab-notes"><h2>Reading the experiment</h2><p>Connection time is the wait for the first decoded frame. Relative delivery lag compares the arrival of identical frames. Neither is the full delay from the camera sensor to your screen. The camera timestamp has not been calibrated against a trusted clock.</p><p class="small-note">The experiment does not enable AI counting, predictions, automatic settlement or recording. Public camera availability is controlled by its operator.</p></section>
  `,
  styles: [`
    .lab-notice{margin-bottom:24px}.lab-notice p{margin:8px 0 0}.lab-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px;align-items:start}
    .lab-panel{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:24px}.lab-panel-heading,.lab-controls{display:flex;justify-content:space-between;align-items:center;gap:12px}.lab-panel h2{margin:18px 0 8px}.lab-video{aspect-ratio:16/9;background:#111d2c;border-radius:12px;overflow:hidden;position:relative}.lab-video iframe{position:absolute;width:100%;height:100%;border:0}.lab-placeholder{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center;padding:20px;color:#eef3fa;gap:8px}.lab-placeholder>span{font-size:32px;line-height:1}.lab-placeholder p{max-width:340px;font-size:12px;color:#b6c2d2;margin:0 0 8px}.lab-controls{margin:18px 0;min-height:36px}.lab-notes{margin-top:22px}.lab-notes h2{margin-top:0}.small-note a{text-decoration:underline;text-underline-offset:3px}
    @media(max-width:1100px){.lab-grid{grid-template-columns:1fr}}@media(max-width:550px){.lab-panel{padding:16px}.lab-video{aspect-ratio:auto;min-height:290px}}
  `]
})
export class StreamingLabComponent implements OnInit, OnDestroy {
  readonly preview = environment.preview;
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);
  private stopTimer?: ReturnType<typeof setTimeout>;
  playing = false;
  presenceExpired = false;
  reference?: TrafficStream;
  referenceFailed = false;

  ngOnInit(): void {
    this.api.listStreams().pipe(timeout(10_000), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (streams) => { this.reference = streams.find((s) => s.isActive && s.streamType === 'hls'); this.referenceFailed = !this.reference; },
      error: () => { this.referenceFailed = true; }
    });
  }
  start(): void {
    if (this.preview) return;
    this.stop();
    this.presenceExpired = false;
    this.playing = true;
    this.stopTimer = setTimeout(() => { this.stop(); this.presenceExpired = true; }, 600_000);
  }
  stop(): void {
    if (this.stopTimer !== undefined) clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    this.playing = false;
  }
  ngOnDestroy(): void { this.stop(); }
}
