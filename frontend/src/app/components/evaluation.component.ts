import { DatePipe, JsonPipe, NgFor, NgIf } from '@angular/common';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Component, DestroyRef, ElementRef, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Observable, Subscription, timeout } from 'rxjs';
import { environment } from '../../environments/environment';
import { CountingPreparation, CountingProfile, CountingSnapshot, SourceHealth } from '../models';
import { apiError } from '../services/ui-helpers';

interface ManualCrossing { track: string; offsetMs: number; direction: string; class: string; uncertain: boolean; }
interface AnnotationDraft { split: string; condition: string; timingEvidence: string; note: string; crossings: ManualCrossing[]; startOffsetMs?: number; endOffsetMs?: number; }
interface ManualInterval extends AnnotationDraft { evidenceId?: number; provenance?: string; profileId: number; clipSha256: string; durationMs: number; captureStart: string | null; }
interface EvaluationItem { id: number; annotation: ManualInterval; createdBy: number; createdAt: string; reviewOutcome: string; }
interface VideoEvidence {
 id: number; streamId: number; streamTitle: string; profileId: number;
 status: 'queued' | 'capturing' | 'processing' | 'ready' | 'failed' | 'interrupted';
 createdAt: string; requestedSeconds: number; durationMs: number; clipSha256?: string;
 countingRules: CountingSnapshot;
 quality?: { framesDecoded: boolean; relativeCoverageComplete: boolean; captureTimeTrusted: boolean; captureStart: string | null; timingBasis: string; issues: string[]; segmentCount: number; decodedFrames: number; firstPTS?: number; lastPTS?: number; missingSequences: number[]; ptsGaps: unknown[]; framingStatus: string; };
 errorCode?: string;
}
interface CursorPage<T> { items: T[]; hasMore: boolean; }

@Component({ selector: 'app-evaluation', standalone: true, imports: [FormsModule, NgIf, NgFor, DatePipe, JsonPipe], template: `
 <section class="panel evaluation-panel">
  <div class="section-toolbar"><div><h2>Retained video &amp; manual labels</h2><p class="small-note">Capture real footage, inspect its quality, then mark individual vehicles against the saved counting rule. An annotation never settles a round or changes virtual credits.</p></div><button class="button compact" type="button" (click)="refresh()" [disabled]="busy">Refresh evidence</button></div>
  <p class="error message" *ngIf="error" role="alert">{{ error }}</p><p class="success message" *ngIf="message" role="status">{{ message }}</p>
  <p class="notice" *ngIf="preview">Video evidence requires the running Go API. Preview data cannot establish real coverage or provide a retained clip.</p>
  <details class="capture-details" *ngIf="!preview"><summary>Capture a new interval</summary><form #captureForm="ngForm" (ngSubmit)="capture()" class="capture-form">
   <div class="form-grid three-columns"><label>Camera<select name="captureCamera" [ngModel]="captureStreamId" (ngModelChange)="selectCaptureCamera(+$event)" [disabled]="busy" required><option [ngValue]="0">Select a camera</option><option *ngFor="let camera of captureCameras" [ngValue]="camera.streamId">{{ camera.title }}</option></select></label>
   <label>Saved rule version<select name="captureRule" [(ngModel)]="captureProfileId" [disabled]="busy || profileLoading" required><option [ngValue]="0">{{ profileLoading ? 'Loading rule versions…' : 'Select a rule version' }}</option><option *ngFor="let profile of captureProfiles" [ngValue]="profile.id">v{{ profile.version }} · {{ profile.definition.label }} · {{ profile.approved ? 'approved' : 'draft' }}</option></select></label>
   <label>Requested duration, seconds<input name="captureDuration" type="number" [(ngModel)]="captureSeconds" min="30" max="900" step="1" required [disabled]="busy"></label></div>
   <p class="small-note" *ngIf="captureStreamId && !profileLoading && !captureProfiles.length">Save a counting rule for the current camera source in Counting rules first. A matching draft can be used for calibration before approval.</p>
   <p class="small-note">Capture runs on the local server. It records receipt time and media timestamps separately; neither establishes the camera's real UTC capture time.</p><button class="button primary" type="submit" [disabled]="busy || captureForm.invalid || !captureStreamId || !captureProfileId || profileLoading">Capture real footage</button>
  </form></details>
  <div class="evidence-list" *ngIf="!preview" aria-label="Retained video intervals"><p class="small-note" *ngIf="evidenceLoading">Loading retained footage…</p><p class="empty-note" *ngIf="!evidenceLoading && !evidenceItems.length">No retained intervals yet. Capture footage with a saved rule before creating labels.</p>
   <button *ngFor="let item of evidenceItems" class="evidence-choice" [class.selected]="selected?.id === item.id" type="button" (click)="openEvidence(item.id)" [disabled]="busy"><span><strong>#{{ item.id }} · {{ item.streamTitle }}</strong><small>{{ item.createdAt | date:'medium' }} · {{ item.durationMs > 0 ? formatTime(item.durationMs) : item.requestedSeconds + ' s requested' }}</small></span><span class="tag neutral">{{ item.status }}</span></button>
   <button class="button compact" *ngIf="moreEvidence" type="button" (click)="loadEvidence(true)" [disabled]="evidenceLoading || busy">Load older footage</button>
  </div>
  <p class="small-note" *ngIf="detailLoading" role="status">Loading interval details…</p>
  <section class="evidence-workspace" *ngIf="selected && !detailLoading" aria-label="Manual annotation workspace">
   <div class="section-toolbar"><div><h3>#{{ selected.id }} · {{ selected.streamTitle }}</h3><p class="small-note">Frozen rule v{{ selected.countingRules.version }} · {{ selected.countingRules.definition?.label }} · [start, end)</p></div><span class="tag neutral">{{ selected.status }}</span></div>
   <p class="notice" *ngIf="selected.status !== 'ready'">{{ activeCapture(selected) ? 'Capture or processing is in progress. This panel refreshes automatically; no duration or coverage is verified yet.' : 'This capture has no playable, complete output. Inspect the quality report and capture a new interval.' }} <span *ngIf="selected.errorCode">Code: {{ selected.errorCode }}</span></p>
   <div class="quality-facts" *ngIf="selected.quality as quality"><div><span>Video decoding</span><strong>{{ quality.framesDecoded ? quality.decodedFrames + ' frames decoded' : 'Not verified' }}</strong></div><div><span>Relative media coverage</span><strong>{{ quality.relativeCoverageComplete ? 'Continuous within retained clip' : 'Incomplete or unverified' }}</strong></div><div><span>Capture time, UTC</span><strong>{{ quality.captureTimeTrusted && quality.captureStart ? quality.captureStart : 'Unknown — not inferred' }}</strong></div><div><span>Camera framing</span><strong>{{ (quality.framingStatus || 'unverified').replaceAll('_', ' ') }}</strong></div></div>
   <p class="small-note">A playable clip and sampled framing checks do not prove a fixed scene or real UTC timing. These labels can evaluate clip-relative counting; uncertain capture time cannot validate a timed round.</p>
   <details *ngIf="selected.quality"><summary>Inspect retained evidence manifest</summary><pre>{{ selected | json }}</pre></details>
   <ng-container *ngIf="selected.status === 'ready'">
    <div class="clip-frame" tabindex="0" aria-label="Retained clip player. Space toggles playback; left and right seek 0.1 seconds, or one second with Shift." (keydown)="playerKey($event)">
     <video #clip controls playsinline preload="metadata" [src]="clipURL()" (loadedmetadata)="metadataLoaded()" (timeupdate)="syncPosition()" (playing)="videoError = ''" (error)="playerFailed()" aria-label="Retained real camera footage"></video>
     <svg *ngIf="metadataReady && showLine && selected.countingRules.definition as rule" viewBox="0 0 1000 1000" preserveAspectRatio="none" class="line-overlay" role="img" aria-label="Saved counting line overlay"><line [attr.x1]="rule.lineStart.x * 1000" [attr.y1]="rule.lineStart.y * 1000" [attr.x2]="rule.lineEnd.x * 1000" [attr.y2]="rule.lineEnd.y * 1000" stroke="#ff793f" stroke-width="5"/><circle [attr.cx]="rule.lineStart.x * 1000" [attr.cy]="rule.lineStart.y * 1000" r="8" fill="white"/></svg>
    </div>
    <p class="error message" *ngIf="videoError" role="alert">{{ videoError }} <button class="text-button" type="button" (click)="retryPlayer()">Retry playback</button></p>
    <div class="player-tools"><div class="button-row"><button class="button compact" type="button" (click)="seek(-1)" [disabled]="!metadataReady">−1 s</button><button class="button compact" type="button" (click)="seek(-0.1)" [disabled]="!metadataReady">−0.1 s</button><button class="button compact" type="button" (click)="seek(0.1)" [disabled]="!metadataReady">+0.1 s</button><button class="button compact" type="button" (click)="seek(1)" [disabled]="!metadataReady">+1 s</button></div><output>{{ formatTime(positionMs) }} / {{ formatTime(selected.durationMs) }}</output><label>Speed<select name="clipSpeed" [ngModel]="playbackRate" (ngModelChange)="setPlaybackRate(+$event)" [disabled]="!metadataReady"><option [ngValue]="0.25">0.25×</option><option [ngValue]="0.5">0.5×</option><option [ngValue]="1">1×</option></select></label><label class="check-field"><input type="checkbox" [(ngModel)]="showLine" name="showCountingLine">Show counting line</label></div>
    <p class="small-note">Pause at a vehicle's first allowed crossing. Use the bottom centre of the vehicle as the anchor. Seeking is approximate; enter an exact clip offset below when necessary. Space and arrow shortcuts work while this player has focus.</p>
    <details class="saved-rules"><summary>Read the exact saved counting rule</summary><p>{{ selected.countingRules.definition?.notes }}</p><p class="small-note">Directions: {{ selected.countingRules.definition?.directions?.join(', ') }} · Classes: {{ selected.countingRules.definition?.classes?.join(', ') }} · Anchor: {{ selected.countingRules.definition?.anchor }}</p></details>
    <form #annotationForm="ngForm" (ngSubmit)="save()" class="annotation-form">
     <fieldset [disabled]="busy"><legend>Annotation interval within this clip</legend><div class="form-grid two-columns"><label>Start in parent clip, seconds<input name="intervalStart" type="number" [ngModel]="intervalStartMs / 1000" (ngModelChange)="setIntervalBoundary('start', $event)" min="0" [max]="selected.durationMs / 1000" step="0.001" required></label><label>Excluded end in parent clip, seconds<input name="intervalEnd" type="number" [ngModel]="intervalEndMs / 1000" (ngModelChange)="setIntervalBoundary('end', $event)" min="0" [max]="selected.durationMs / 1000" step="0.001" required></label></div><div class="button-row crossing-action"><button class="button compact" type="button" (click)="boundaryFromPlayer('start')" [disabled]="!metadataReady">Start at current position</button><button class="button compact" type="button" (click)="boundaryFromPlayer('end')" [disabled]="!metadataReady">End at current position</button><button class="button compact" type="button" (click)="seekTo(intervalStartMs)" [disabled]="!metadataReady || !validInterval">Go to interval start</button></div><p class="small-note">Parent clip [{{ formatTime(intervalStartMs) }}, {{ formatTime(intervalEndMs) }}) · {{ formatTime(intervalDurationMs) }} duration. Crossing offsets below start at zero for this interval. Playback can inspect the whole parent clip.</p><p class="small-note">Changing the start keeps existing crossings at their original parent-clip positions. Remove or correct rows that fall outside the new interval.</p><p *ngIf="!validInterval" class="error message" role="alert">Use whole milliseconds, at least one second in duration, entirely within the retained clip.</p></fieldset>
     <fieldset [disabled]="busy"><legend>Mark vehicle crossings</legend><div class="form-grid three-columns"><label>Track label<input name="newTrack" [(ngModel)]="nextTrack" maxlength="80" placeholder="vehicle-001"></label><label>Direction<select name="newDirection" [(ngModel)]="nextDirection"><option *ngFor="let direction of directions" [value]="direction">{{ direction.replaceAll('_', ' ') }}</option></select></label><label>Vehicle class<select name="newClass" [(ngModel)]="nextClass"><option *ngFor="let vehicle of classes" [value]="vehicle">{{ vehicle }}</option></select></label></div><div class="button-row crossing-action"><label class="check-field"><input name="newUncertain" type="checkbox" [(ngModel)]="nextUncertain">Uncertain identity, class or timing</label><button class="button primary" type="button" (click)="addCrossing()" [disabled]="!metadataReady || !!videoError || !validInterval || !positionWithinInterval || draft.crossings.length >= 500">{{ positionWithinInterval ? 'Mark crossing at interval ' + formatTime(positionMs - intervalStartMs) : 'Seek inside selected interval' }}</button></div></fieldset>
     <div class="annotation-count"><strong>{{ draft.crossings.length }} manually marked · {{ certainCount }} certain · {{ uncertainCount }} uncertain</strong><span class="small-note">{{ dirty ? 'Unsaved draft — kept in this page only' : 'No unsaved changes' }}</span></div>
     <p class="small-note" *ngIf="!draft.crossings.length">Zero crossings is a valid manual observation only after inspecting the entire retained interval. Saving never invents a vehicle count.</p>
     <div *ngFor="let crossing of draft.crossings; let i = index" class="crossing-row"><label>Track<input [name]="'track' + i" [(ngModel)]="crossing.track" (ngModelChange)="changed()" maxlength="80" required [disabled]="busy"></label><label>Interval offset, ms<input [name]="'offset' + i" type="number" min="0" [max]="intervalDurationMs - 1" step="1" [(ngModel)]="crossing.offsetMs" (ngModelChange)="changed()" required [disabled]="busy"><small>Parent clip {{ formatTime(intervalStartMs + crossing.offsetMs) }}</small></label><label>Direction<select [name]="'direction' + i" [(ngModel)]="crossing.direction" (ngModelChange)="changed()" [disabled]="busy"><option *ngFor="let direction of directions" [value]="direction">{{ direction.replaceAll('_', ' ') }}</option></select></label><label>Class<select [name]="'class' + i" [(ngModel)]="crossing.class" (ngModelChange)="changed()" [disabled]="busy"><option *ngFor="let vehicle of classes" [value]="vehicle">{{ vehicle }}</option></select></label><label class="check-field"><input [name]="'uncertain' + i" type="checkbox" [(ngModel)]="crossing.uncertain" (ngModelChange)="changed()" [disabled]="busy">Uncertain</label><div class="button-row"><button class="text-button" type="button" (click)="seekTo(intervalStartMs + crossing.offsetMs)" [disabled]="!metadataReady">Inspect</button><button class="text-button" type="button" (click)="removeCrossing(i)" [disabled]="busy">Remove</button></div></div>
     <div class="form-grid two-columns"><label>Dataset split<select name="split" [(ngModel)]="draft.split" (ngModelChange)="changed()" [disabled]="busy"><option value="tuning">Tuning</option><option value="test">Independent test</option></select></label><label>Condition<select name="condition" [(ngModel)]="draft.condition" (ngModelChange)="changed()" [disabled]="busy"><option *ngFor="let condition of conditions" [value]="condition">{{ condition }}</option></select></label></div>
     <label>Timing evidence and uncertainty<textarea name="timingEvidence" [(ngModel)]="draft.timingEvidence" (ngModelChange)="changed()" minlength="20" maxlength="2000" rows="2" required [disabled]="busy" placeholder="Describe clip-relative timing, gaps and what remains unknown."></textarea></label><label>Manual observation notes<textarea name="annotationNote" [(ngModel)]="draft.note" (ngModelChange)="changed()" minlength="20" maxlength="2000" rows="2" required [disabled]="busy" placeholder="Describe what you checked, obscured vehicles and unresolved cases."></textarea></label>
     <p class="small-note">The server binds this interval to retained evidence #{{ selected.id }}, its parent SHA-256 and frozen rule. All subintervals of one parent clip must remain in one dataset split. Saving creates immutable history; independent review remains separate.</p><div class="button-row"><button class="button primary" type="submit" [disabled]="busy || annotationForm.invalid || !!videoError || !validInterval">Save immutable annotation</button><button class="button" type="button" (click)="resetDraft()" [disabled]="busy">Clear this draft</button></div>
    </form>
   </ng-container>
  </section>
  <div class="annotation-history"><h3>Annotation &amp; review history</h3><p class="small-note">Another operator must review accepted examples. Assistant-assisted labels need human review. Synthetic fixtures and unverified UTC timestamps are not ground truth for timed rounds.</p><button class="button compact" type="button" (click)="load()" [disabled]="busy || preview">Refresh annotations</button><p *ngIf="!items.length" class="empty-note">No manually labelled intervals yet.</p>
   <article *ngFor="let item of items"><strong>#{{ item.id }} · {{ item.reviewOutcome }} · {{ item.annotation.split }}</strong><p class="small-note">Rule #{{ item.annotation.profileId }} · {{ item.annotation.condition }} · {{ item.annotation.crossings.length }} annotated tracks · {{ item.annotation.provenance || 'legacy provenance unspecified' }} · author #{{ item.createdBy }} · {{ item.createdAt | date:'medium' }}</p><button class="text-button" type="button" *ngIf="item.annotation.evidenceId" (click)="openEvidence(item.annotation.evidenceId)" [disabled]="busy">Open retained evidence #{{ item.annotation.evidenceId }}</button><p class="small-note" *ngIf="!item.annotation.evidenceId">Legacy annotation: no retained clip is bound to this record.</p><details><summary>Inspect saved annotation</summary><p class="small-note">Parent clip [{{ formatTime(item.annotation.startOffsetMs || 0) }}, {{ formatTime(item.annotation.endOffsetMs ?? ((item.annotation.startOffsetMs || 0) + item.annotation.durationMs)) }}) · {{ formatTime(item.annotation.durationMs) }} labelled interval</p><p class="small-note" *ngFor="let crossing of item.annotation.crossings">{{ crossing.track }} · interval +{{ formatTime(crossing.offsetMs) }} · parent clip {{ formatTime((item.annotation.startOffsetMs || 0) + crossing.offsetMs) }} · {{ crossing.class }} · {{ crossing.direction }}{{ crossing.uncertain ? ' · uncertain' : '' }}</p><pre>{{ item.annotation | json }}</pre></details><label>Independent review notes<input [ngModel]="reviewNotes[item.id] || ''" (ngModelChange)="reviewNotes[item.id] = $event" minlength="20" maxlength="2000" [disabled]="busy"></label><div class="button-row"><button *ngFor="let outcome of ['accepted','disputed','unverifiable']" class="button compact" type="button" (click)="review(item.id, outcome)" [disabled]="busy || (reviewNotes[item.id] || '').trim().length < 20">{{ outcome }}</button></div></article><button class="button" *ngIf="more" type="button" (click)="load(true)" [disabled]="busy">Load older annotations</button>
  </div>
 </section>
`, styles: [`
 :host{display:block;min-width:0}.evaluation-panel{padding:24px}.section-toolbar h2,.section-toolbar h3{margin:0 0 8px}.section-toolbar .small-note{margin:0;max-width:850px}details{margin:16px 0}summary{cursor:pointer;font-weight:600;font-size:12px;line-height:1.6}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;font-size:11px;line-height:1.6;background:var(--bg);padding:14px;border-radius:8px}.capture-details{border:1px solid var(--line);border-radius:9px;padding:16px}.capture-form{margin-top:18px}.evidence-list{display:grid;gap:8px;margin:20px 0}.evidence-choice{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 16px;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;text-align:left}.evidence-choice.selected{border-color:var(--orange);box-shadow:inset 3px 0 var(--orange)}.evidence-choice>span:first-child{display:grid;gap:7px;min-width:0}.evidence-choice strong{font-size:12px;overflow-wrap:anywhere}.evidence-choice small{font-size:11px;color:var(--muted)}.evidence-workspace{border-top:1px solid var(--line);padding-top:24px;margin-top:22px}.quality-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;background:var(--bg);padding:16px;border:1px solid var(--line);border-radius:8px;margin-bottom:15px}.quality-facts>div{display:grid;gap:6px}.quality-facts span{font-size:11px;color:var(--muted)}.quality-facts strong{font-size:12px;line-height:1.5;overflow-wrap:anywhere}.clip-frame{position:relative;background:#0e1721;border-radius:9px;overflow:hidden;margin-top:20px}.clip-frame video{width:100%;height:auto;display:block}.line-overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.player-tools{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:14px 0}.player-tools output{font-family:Consolas,monospace;font-size:12px}.player-tools>label:not(.check-field){display:flex;align-items:center;gap:8px}.player-tools select{width:auto;min-height:34px;padding:6px}.annotation-form{display:grid;gap:18px}.annotation-form fieldset{margin:0;border:1px solid var(--line);padding:16px;border-radius:8px;min-width:0}.annotation-form legend{font-size:12px;font-weight:600;padding:0 6px}.crossing-action{margin-top:16px;justify-content:space-between}.annotation-count{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12px}.annotation-count .small-note{margin:0}.crossing-row{display:grid;grid-template-columns:minmax(100px,1.2fr) minmax(105px,1fr) minmax(100px,1fr) minmax(90px,1fr) auto auto;gap:12px;align-items:end;border-top:1px solid var(--line);padding-top:16px}.crossing-row .check-field{align-self:center}.crossing-row .button-row{padding-bottom:4px}.annotation-history{margin-top:30px;border-top:1px solid var(--line);padding-top:24px}.annotation-history article{border-top:1px solid var(--line);padding:20px 0}.annotation-history article>strong{font-size:13px}.annotation-history article>label{margin:16px 0}.annotation-history h3{margin-bottom:8px}.saved-rules p{font-size:12px;line-height:1.7;margin-top:12px}@media(max-width:1100px){.crossing-row{grid-template-columns:repeat(3,minmax(0,1fr));align-items:end}}@media(max-width:650px){.evaluation-panel{padding:20px 15px}.quality-facts{grid-template-columns:1fr}.crossing-row{grid-template-columns:repeat(2,minmax(0,1fr))}.player-tools{gap:12px}.player-tools .button-row{gap:6px}.evidence-choice{padding:12px;gap:8px}.evidence-choice strong{font-size:11px}.section-toolbar{flex-wrap:wrap}}
`] })
export class EvaluationComponent implements OnInit, OnDestroy {
 private readonly http = inject(HttpClient); private readonly destroyRef = inject(DestroyRef);
 @ViewChild('clip') video?: ElementRef<HTMLVideoElement>;
 readonly preview = environment.preview;
 readonly conditions = ['day', 'night', 'glare', 'rain', 'snow', 'occluded', 'unknown']; readonly classes = ['car', 'van', 'bus', 'truck', 'motorcycle', 'unknown']; readonly directions = ['A_to_B', 'B_to_A'];
 draft: AnnotationDraft = this.empty(); items: EvaluationItem[] = []; evidenceItems: VideoEvidence[] = []; selected?: VideoEvidence;
 more = false; moreEvidence = false; busy = false; error = ''; message = ''; evidenceLoading = false; detailLoading = false; profileLoading = false;
 captureCameras: SourceHealth['cameras'] = []; captureProfiles: CountingProfile[] = []; captureStreamId = 0; captureProfileId = 0; captureSeconds = 60;
 reviewNotes: Record<number, string> = {}; positionMs = 0; playbackRate = 1; showLine = true; metadataReady = false; videoError = ''; dirty = false;
 nextTrack = 'vehicle-001'; nextDirection = 'A_to_B'; nextClass = 'car'; nextUncertain = false;
 private reads = new Map<string, Subscription>(); private generations = new Map<string, number>(); private drafts = new Map<number, { value: AnnotationDraft; dirty: boolean }>(); private timer?: number; private alive = true; private playerGeneration = 0;

 ngOnInit(): void {
  if (this.preview) return;
  this.refresh();
  this.read('cameras', this.get<SourceHealth>('/admin/source-health'), (data) => { this.captureCameras = data.cameras.filter((camera) => camera.isActive); });
  this.timer = window.setInterval(() => { if (!document.hidden && !this.busy && (this.evidenceItems.some((item) => this.activeCapture(item)) || (this.selected && this.activeCapture(this.selected)))) { this.loadEvidence(false, true); if (this.selected && this.activeCapture(this.selected)) this.refreshSelected(); } }, 15_000);
 }
 ngOnDestroy(): void { this.alive = false; this.reads.forEach((request) => request.unsubscribe()); this.reads.clear(); if (this.timer) window.clearInterval(this.timer); this.stopPlayer(); this.drafts.clear(); }
 refresh(): void { if (this.preview) return; this.error = ''; this.loadEvidence(); this.load(); if (this.selected) this.refreshSelected(); }
 private get<T>(path: string, before?: number): Observable<T> { return this.http.get<T>(`${environment.apiUrl}${path}`, { withCredentials: true, params: before ? new HttpParams().set('before', before) : new HttpParams() }); }
 private read<T>(key: string, request: Observable<T>, next: (value: T) => void, failed?: () => void): void {
  this.reads.get(key)?.unsubscribe(); const generation = (this.generations.get(key) ?? 0) + 1; this.generations.set(key, generation);
  this.reads.set(key, request.pipe(timeout(15_000), takeUntilDestroyed(this.destroyRef)).subscribe({ next: (data) => { if (this.alive && this.generations.get(key) === generation) next(data); }, error: (error) => { if (this.alive && this.generations.get(key) === generation) { this.error = apiError(error); failed?.(); } } }));
 }
 load(older = false): void { if (this.preview) return; const before = older ? this.items.at(-1)?.id : undefined; this.read('annotations', this.get<CursorPage<EvaluationItem>>('/admin/evaluation', before), (data) => { this.items = older ? this.merge(this.items, data.items) : data.items; this.more = data.hasMore; }); }
 loadEvidence(older = false, preserve = false): void {
  if (this.preview) return; this.evidenceLoading = true; const before = older ? this.evidenceItems.at(-1)?.id : undefined;
  this.read('evidence', this.get<CursorPage<VideoEvidence>>('/admin/video-evidence', before), (data) => { this.evidenceLoading = false; this.evidenceItems = older || preserve ? this.merge(this.evidenceItems, data.items) : data.items; if (!preserve) this.moreEvidence = data.hasMore; if (!this.selected && !this.detailLoading) { const first = data.items.find((item) => item.status === 'ready') ?? data.items[0]; if (first) this.openEvidence(first.id); } }, () => this.evidenceLoading = false);
 }
 private merge<T extends { id: number }>(existing: T[], incoming: T[]): T[] { return [...new Map([...existing, ...incoming].map((item) => [item.id, item])).values()].sort((a, b) => b.id - a.id); }
 selectCaptureCamera(id: number): void {
  if (this.busy) return; this.captureStreamId = id; this.captureProfileId = 0; this.captureProfiles = [];
  this.reads.get('profiles')?.unsubscribe(); this.generations.set('profiles', (this.generations.get('profiles') ?? 0) + 1);
  if (!Number.isSafeInteger(id) || id < 1) { this.profileLoading = false; return; }
  this.profileLoading = true;
  this.read('profiles', this.get<CountingPreparation>('/admin/preparation/' + id), (data) => { this.captureProfiles = data.profiles.filter((profile) => profile.sourceMatches); this.captureProfileId = this.captureProfiles[0]?.id ?? 0; this.profileLoading = false; }, () => this.profileLoading = false);
 }
 capture(): void {
  if (this.busy || this.preview) return;
  if (!Number.isSafeInteger(this.captureStreamId) || this.captureStreamId < 1 || !this.captureProfiles.some((profile) => profile.id === this.captureProfileId) || !Number.isSafeInteger(this.captureSeconds) || this.captureSeconds < 30 || this.captureSeconds > 900) { this.error = 'Select a matching saved rule and an integer duration from 30 to 900 seconds.'; return; }
  this.mutate('/admin/video-evidence', { streamId: this.captureStreamId, profileId: this.captureProfileId, durationSeconds: this.captureSeconds }, (data: { id?: number }) => { this.message = 'Capture queued. The server will retain footage and report quality separately from UTC timing.'; this.loadEvidence(); if (data.id) this.openEvidence(data.id); });
 }
 openEvidence(id: number): void {
  if (this.busy || !Number.isSafeInteger(id) || id < 1 || this.preview) return;
  if (this.selected?.id === id && !this.detailLoading) return;
  this.rememberDraft(); this.stopPlayer(); this.selected = undefined; this.metadataReady = false; this.positionMs = 0; this.playbackRate = 1; this.videoError = ''; this.error = ''; this.detailLoading = true;
  this.read('detail', this.get<VideoEvidence>('/admin/video-evidence/' + id), (data) => { this.selected = data; this.detailLoading = false; const saved = this.drafts.get(id); this.draft = saved ? structuredClone(saved.value) : this.empty(); this.dirty = saved?.dirty ?? false; this.resetMarker(); }, () => this.detailLoading = false);
 }
 private refreshSelected(): void { const id = this.selected?.id; if (!id) return; this.read('detail', this.get<VideoEvidence>('/admin/video-evidence/' + id), (data) => { if (this.selected?.id === id) this.selected = data; }); }
 activeCapture(item: VideoEvidence): boolean { return ['queued', 'capturing', 'processing'].includes(item.status); }
 clipURL(): string { return this.selected?.status === 'ready' ? `${environment.apiUrl}/admin/video-evidence/${this.selected.id}/clip.mp4` : ''; }
 metadataLoaded(): void {
  const video = this.video?.nativeElement;
  if (!video || !this.selected || !Number.isFinite(video.duration) || video.duration <= 0) { this.playerFailed(); return; }
  this.metadataReady = true; this.videoError = ''; video.playbackRate = this.playbackRate; this.syncPosition();
 }
 syncPosition(): void { const value = this.video?.nativeElement.currentTime; if (value !== undefined && Number.isFinite(value)) this.positionMs = Math.max(0, Math.round(value * 1000)); }
 playerFailed(): void { this.metadataReady = false; this.videoError = 'The retained clip could not be played. Refresh evidence or sign in again; annotations are not submitted automatically.'; }
 retryPlayer(): void { if (this.selected?.status !== 'ready' || !this.video) return; this.playerGeneration++; this.metadataReady = false; this.videoError = ''; this.video.nativeElement.load(); }
 private stopPlayer(): void { this.playerGeneration++; const video = this.video?.nativeElement; if (video) { video.pause(); video.removeAttribute('src'); video.load(); } }
 seek(seconds: number): void { this.seekTo(this.positionMs + seconds * 1000); }
 seekTo(offsetMs: number): void {
  const video = this.video?.nativeElement;
  if (!video || !this.selected || !this.metadataReady || !Number.isFinite(offsetMs)) return;
  video.pause(); video.currentTime = Math.min(Math.max(0, offsetMs), Math.max(0, Math.min(this.selected.durationMs, video.duration * 1000) - 1)) / 1000; this.syncPosition();
 }
 setPlaybackRate(value: number): void { if (![0.25, 0.5, 1].includes(value)) return; this.playbackRate = value; if (this.video?.nativeElement) this.video.nativeElement.playbackRate = value; }
 get intervalStartMs(): number { return this.draft.startOffsetMs ?? 0; }
 get intervalEndMs(): number { return this.draft.endOffsetMs ?? this.selected?.durationMs ?? 0; }
 get intervalDurationMs(): number { return this.intervalEndMs - this.intervalStartMs; }
 get validInterval(): boolean { return !!this.selected && Number.isSafeInteger(this.intervalStartMs) && Number.isSafeInteger(this.intervalEndMs) && this.intervalStartMs >= 0 && this.intervalEndMs <= this.selected.durationMs && this.intervalDurationMs >= 1000; }
 get positionWithinInterval(): boolean { return this.validInterval && this.positionMs >= this.intervalStartMs && this.positionMs < this.intervalEndMs; }
 setIntervalBoundary(boundary: 'start' | 'end', seconds: number | null): void {
  if (this.busy) return;
  const raw = seconds === null ? NaN : seconds * 1000;
  // Decimal seconds such as 32.001 can have binary floating-point noise. Only
  // remove that noise; preserve actual sub-millisecond input as invalid.
  const value = Number.isFinite(raw) && Math.abs(raw - Math.round(raw)) < 0.000001 ? Math.round(raw) : raw;
  if (!Number.isFinite(value)) { this.error = 'Enter a finite interval boundary in seconds.'; return; }
  if (boundary === 'start') { const previous = this.intervalStartMs; this.draft.startOffsetMs = value; if (Number.isFinite(previous) && Number.isFinite(value)) this.draft.crossings.forEach((item) => item.offsetMs += previous - value); }
  else this.draft.endOffsetMs = value;
  this.changed();
 }
 boundaryFromPlayer(boundary: 'start' | 'end'): void { if (!this.metadataReady || this.busy) return; this.syncPosition(); this.setIntervalBoundary(boundary, this.positionMs / 1000); }
 playerKey(event: KeyboardEvent): void {
  const tag = (event.target as HTMLElement | null)?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(tag ?? '') || event.ctrlKey || event.metaKey || event.altKey || !this.metadataReady) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); this.seek((event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.1)); }
  if (event.key === ' ') { event.preventDefault(); const video = this.video?.nativeElement, evidenceId = this.selected?.id, generation = this.playerGeneration; if (video) { if (video.paused) { const result = video.play(); result?.catch(() => { if (this.alive && generation === this.playerGeneration && this.selected?.id === evidenceId && this.video?.nativeElement === video) this.videoError = 'Playback could not start. Use the video play control to retry.'; }); } else video.pause(); } }
 }
 addCrossing(): void {
  if (this.busy || !this.metadataReady || this.videoError || this.selected?.status !== 'ready' || this.draft.crossings.length >= 500) return;
  this.syncPosition(); const track = this.nextTrack.trim(), offsetMs = this.positionMs - this.intervalStartMs;
  if (!track || track.length > 80 || this.draft.crossings.some((item) => item.track.trim() === track)) { this.error = 'Use a unique track label for the vehicle. Count its first allowed crossing only once.'; return; }
  if (!this.validInterval || !Number.isSafeInteger(offsetMs) || offsetMs < 0 || offsetMs >= this.intervalDurationMs) { this.error = 'Choose a crossing within the selected interval, before its excluded end.'; return; }
  this.video?.nativeElement.pause(); this.draft.crossings.push({ track, offsetMs, direction: this.nextDirection, class: this.nextClass, uncertain: this.nextUncertain }); this.error = ''; this.changed(); this.resetMarker();
 }
 private resetMarker(): void { let number = this.draft.crossings.length + 1; while (this.draft.crossings.some((item) => item.track === `vehicle-${String(number).padStart(3, '0')}`)) number++; this.nextTrack = `vehicle-${String(number).padStart(3, '0')}`; this.nextDirection = this.selected?.countingRules.definition?.directions[0] ?? 'A_to_B'; this.nextClass = this.selected?.countingRules.definition?.classes[0] ?? 'car'; this.nextUncertain = false; }
 removeCrossing(index: number): void { if (this.busy || index < 0 || index >= this.draft.crossings.length) return; this.draft.crossings.splice(index, 1); this.changed(); }
 changed(): void { this.dirty = true; }
 get uncertainCount(): number { return this.draft.crossings.filter((item) => item.uncertain).length; }
 get certainCount(): number { return this.draft.crossings.length - this.uncertainCount; }
 private rememberDraft(): void { if (this.selected) this.drafts.set(this.selected.id, { value: structuredClone(this.draft), dirty: this.dirty }); }
 resetDraft(): void { if (this.busy) return; this.draft = this.empty(); this.dirty = false; if (this.selected) this.drafts.delete(this.selected.id); this.resetMarker(); }
 save(): void {
  if (this.busy || this.preview || this.selected?.status !== 'ready') return;
  const rule = this.selected.countingRules.definition, seen = new Set<string>();
  if (!this.validInterval) { this.error = 'Choose a whole-millisecond interval of at least one second within the parent clip.'; return; }
  if (!['tuning', 'test'].includes(this.draft.split) || !this.conditions.includes(this.draft.condition) || this.draft.timingEvidence.trim().length < 20 || this.draft.note.trim().length < 20 || this.draft.timingEvidence.length > 2000 || this.draft.note.length > 2000 || this.draft.crossings.length > 500) { this.error = 'Add observation and timing notes of 20–2000 characters and a valid condition and split.'; return; }
  for (const item of this.draft.crossings) {
   const track = item.track.trim();
   if (!track || track.length > 80 || seen.has(track) || !Number.isSafeInteger(item.offsetMs) || item.offsetMs < 0 || item.offsetMs >= this.intervalDurationMs || !this.directions.includes(item.direction) || !this.classes.includes(item.class) || (!item.uncertain && (!rule?.directions.includes(item.direction) || !rule.classes.includes(item.class)))) { this.error = 'Check unique track labels, interval offsets, direction and class. Mark unresolved or excluded cases as uncertain.'; return; }
   seen.add(track);
  }
  const id = this.selected.id, body: AnnotationDraft = structuredClone(this.draft); body.crossings.forEach((item) => item.track = item.track.trim());
  delete body.startOffsetMs; delete body.endOffsetMs;
  if (this.intervalStartMs !== 0 || this.intervalEndMs !== this.selected.durationMs) { body.startOffsetMs = this.intervalStartMs; body.endOffsetMs = this.intervalEndMs; }
  this.mutate('/admin/video-evidence/' + id + '/annotation', body, () => { this.drafts.delete(id); this.dirty = false; this.message = 'Immutable annotation saved against the retained clip. Independent review remains separate; no credits changed.'; this.load(); });
 }
 review(id: number, outcome: string): void { if (this.busy || !['accepted', 'disputed', 'unverifiable'].includes(outcome) || (this.reviewNotes[id] ?? '').trim().length < 20) return; this.mutate('/admin/evaluation/' + id, { outcome, note: this.reviewNotes[id] }, () => { this.message = 'Independent review recorded. Annotation history is unchanged; no credits moved.'; this.load(); }); }
 private mutate<T>(path: string, body: unknown, done: (value: T) => void): void {
  this.busy = true; this.error = ''; this.message = '';
  this.http.post<T>(`${environment.apiUrl}${path}`, body, { withCredentials: true }).pipe(timeout(20_000), takeUntilDestroyed(this.destroyRef)).subscribe({ next: (data) => { if (!this.alive) return; this.busy = false; done(data); }, error: (error) => { if (!this.alive) return; this.busy = false; this.error = apiError(error) + ' Refresh before retrying if the connection was interrupted.'; } });
 }
 formatTime(milliseconds: number): string { if (!Number.isFinite(milliseconds) || milliseconds < 0) return '00:00.000'; const value = Math.round(milliseconds); return `${String(Math.floor(value / 60000)).padStart(2, '0')}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')}.${String(value % 1000).padStart(3, '0')}`; }
 private empty(): AnnotationDraft { return { split: 'tuning', condition: 'unknown', timingEvidence: '', note: '', crossings: [] }; }
}
