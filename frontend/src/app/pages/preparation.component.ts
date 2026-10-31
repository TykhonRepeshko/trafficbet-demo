import { DatePipe, JsonPipe, NgFor, NgIf } from '@angular/common';
import { Component, DestroyRef, OnDestroy, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Observable, Subscription, timeout } from 'rxjs';
import { AuditItem, CountingDefinition, CountingPreparation, CountingProfile, ReviewDetail, ReviewQueueItem, RoundReview, SourceHealth } from '../models';
import { ApiService } from '../services/api.service';
import { apiError } from '../services/ui-helpers';
import { OperationsComponent } from '../components/operations.component';

@Component({ standalone: true, selector: 'app-preparation', imports: [DatePipe, JsonPipe, NgFor, NgIf, FormsModule, RouterLink, OperationsComponent], templateUrl: './preparation.component.html', styleUrl: './preparation.component.css' })
export class PreparationComponent implements OnInit, OnDestroy {
  readonly api = inject(ApiService); private readonly destroyRef = inject(DestroyRef);
  health?: SourceHealth; preparation?: CountingPreparation; detail?: ReviewDetail;
  queue: ReviewQueueItem[] = []; audit: AuditItem[] = []; moreQueue = false; moreAudit = false;
  error = ''; message = ''; busy = false; loading = false; selected = 0; referenceId = 0; approvalNote = '';
  outcome: RoundReview['outcome'] = 'needs_review'; proposedCount?: number; evidenceId?: number; note = ''; timeOK = false; coverageOK = false; framingOK = false;
  cancelReason = ''; confirmCancel = false;
  readonly classes = ['car', 'van', 'bus', 'truck', 'motorcycle'];
  definition: CountingDefinition = this.emptyDefinition();
  private reads = new Map<string, Subscription>(); private generations = new Map<string, number>(); private timer?: number; private alive = true;
  ngOnInit(): void { this.refresh(); this.timer = window.setInterval(() => { if (!document.hidden && !this.busy) this.loadHealth(); }, 15_000); }
  ngOnDestroy(): void { this.alive = false; this.reads.forEach((request) => request.unsubscribe()); if (this.timer) window.clearInterval(this.timer); }
  private read<T>(key: string, request: Observable<T>, next: (value: T) => void): void {
    this.reads.get(key)?.unsubscribe(); const generation = (this.generations.get(key) ?? 0) + 1; this.generations.set(key, generation);
    this.reads.set(key, request.pipe(timeout(15_000), takeUntilDestroyed(this.destroyRef)).subscribe({ next: (data) => { if (this.alive && this.generations.get(key) === generation) next(data); }, error: (error) => { if (this.alive && this.generations.get(key) === generation) { this.error = apiError(error); this.loading = false; } } }));
  }
  refresh(): void { this.error = ''; this.loadHealth(); this.loadQueue(); this.loadAudit(); }
  loadHealth(): void { this.read('health', this.api.sourceHealth(), (data) => this.health = data); }
  stale(camera: SourceHealth['cameras'][number]): boolean { return !camera.observation || camera.observation.sourceFingerprint !== camera.sourceFingerprint || Date.now() - Date.parse(camera.observation.observedAt) > 120_000; }
  selectCamera(id: number): void {
    if (this.busy) return; this.selected = id; this.preparation = undefined; this.referenceId = 0; this.definition = this.emptyDefinition(); this.approvalNote = ''; this.error = ''; this.loading = true;
    this.read('preparation', this.api.preparation(id), (data) => { this.preparation = data; this.loading = false; this.referenceId = data.references.find((ref) => ref.sourceFingerprint === data.sourceFingerprint)?.id ?? 0; });
  }
  referenceURL(): string { return this.referenceId ? this.api.referenceURL(this.selected, this.referenceId) : ''; }
  upload(event: Event): void {
    const input = event.target as HTMLInputElement, file = input.files?.[0]; if (!file || this.busy) return;
    if (file.size > 1_048_576 || file.type !== 'image/png') { this.error = 'Choose a PNG up to 1 MiB and 1920 × 1080 pixels.'; input.value = ''; return; }
    const id = this.selected; this.mutate(this.api.uploadReference(id, file), 'Reference saved. Its clock and origin still require operator verification.', () => this.selectCamera(id)); input.value = '';
  }
  toggleClass(value: string, checked: boolean): void { this.definition.classes = checked ? [...new Set([...this.definition.classes, value])] : this.definition.classes.filter((item) => item !== value); }
  toggleDirection(value: string, checked: boolean): void { this.definition.directions = checked ? [...new Set([...this.definition.directions, value])] : this.definition.directions.filter((item) => item !== value); }
  copyProfile(profile: CountingProfile): void { this.definition = structuredClone(profile.definition); this.referenceId = profile.referenceId; this.message = 'Copied into a new draft. The saved version is unchanged.'; }
  saveProfile(): void {
    if (!this.referenceId || this.busy) return;
    const id = this.selected; this.mutate(this.api.saveCountingProfile(id, this.referenceId, this.definition), 'New immutable rule version saved. Review it before approval.', () => this.selectCamera(id));
  }
  approve(profile: CountingProfile): void { if (this.busy || !profile.sourceMatches || this.approvalNote.trim().length < 20) return; const id = this.selected; this.mutate(this.api.approveCountingProfile(id, profile.id, this.approvalNote), 'Approved for newly published rounds. Existing rounds keep their original rules.', () => { this.selectCamera(id); this.loadHealth(); }); }
  loadQueue(older = false): void { const before = older ? this.queue.at(-1)?.id : undefined; this.read('queue', this.api.reviewQueue(before), (page) => { this.queue = older ? [...this.queue, ...page.items] : page.items; this.moreQueue = page.hasMore; }); }
  loadAudit(older = false): void { const before = older ? this.audit.at(-1)?.id : undefined; this.read('audit', this.api.auditPage(before), (page) => { this.audit = older ? [...this.audit, ...page.items] : page.items; this.moreAudit = page.hasMore; }); }
  openReview(id: number): void { if (this.busy) return; this.detail = undefined; this.note = ''; this.proposedCount = undefined; this.evidenceId = undefined; this.outcome = 'needs_review'; this.timeOK = this.coverageOK = this.framingOK = false; this.cancelReason = ''; this.confirmCancel = false; this.read('review', this.api.roundReview(id), (data) => this.detail = data); }
  saveReview(): void {
    if (!this.detail || this.busy) return;
    if (this.outcome === 'verified' && this.detail.snapshot?.profileId) { this.error = 'Retained video is currently disabled. Versioned UTC rounds cannot be verified or settled without complete trusted footage; cancel and refund unverifiable rounds.'; return; }
    const evidenceId = this.evidenceId == null ? undefined : this.evidenceId;
    if (evidenceId !== undefined && (!Number.isSafeInteger(evidenceId) || evidenceId < 1)) { this.error = 'Enter a positive whole retained evidence ID.'; return; }
    if (this.outcome === 'verified' && (!this.timeOK || !this.coverageOK || !this.framingOK || !Number.isInteger(this.proposedCount))) { this.error = 'Verification requires a count and evidence for timing, coverage and framing.'; return; }
    if (this.outcome === 'verified' && this.detail.snapshot?.profileId && evidenceId === undefined) { this.error = 'Versioned UTC rounds require retained evidence with trusted capture UTC, complete interval coverage and checked framing. Checkboxes alone are insufficient.'; return; }
    const id = this.detail.market.id;
    this.mutate(this.api.saveRoundReview(id, { outcome: this.outcome, proposedCount: this.proposedCount, evidenceId, evidenceNote: this.note, verification: { captureTimeVerified: this.timeOK, coverageVerified: this.coverageOK, framingVerified: this.framingOK, evidenceNote: this.note } }), 'Review recorded. No credits moved.', () => { this.openReview(id); this.loadQueue(); this.loadAudit(); });
  }
  get confirmedReview(): RoundReview | undefined { if (this.detail?.snapshot?.profileId) return undefined; const latest = this.detail?.reviews[0]; return latest?.outcome === 'verified' && Number.isInteger(latest.proposedCount) ? latest : undefined; }
  settle(): void { const review = this.confirmedReview; if (!this.detail || !review || this.busy) return; const id = this.detail.market.id; this.mutate(this.api.settleMarket(id, review.proposedCount!, review.verification), 'Result confirmed and virtual credits settled.', () => { this.openReview(id); this.loadQueue(); this.loadAudit(); }); }
  cancel(): void { if (!this.detail || !this.confirmCancel || this.cancelReason.trim().length < 5 || this.busy) return; const id = this.detail.market.id; this.mutate(this.api.voidMarket(id, this.cancelReason), 'Round cancelled. Pending stakes refunded once.', () => { this.openReview(id); this.loadQueue(); this.loadAudit(); }); }
  private mutate<T>(request: Observable<T>, message: string, done: () => void): void {
    if (this.busy) return; this.busy = true; this.error = ''; this.message = '';
    // A timed out mutation may have committed. Always reload before retrying.
    request.pipe(timeout(20_000), takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { this.busy = false; this.message = message; done(); }, error: (error) => { this.busy = false; this.error = apiError(error) + ' Refresh before retrying if the connection was interrupted.'; } });
  }
  private emptyDefinition(): CountingDefinition { return { label: '', lineStart: { x: 0.1, y: 0.5 }, lineEnd: { x: 0.9, y: 0.5 }, directions: ['A_to_B', 'B_to_A'], classes: ['car', 'van', 'bus', 'truck', 'motorcycle'], anchor: 'bottom_center', timeBasis: 'capture_utc', notes: '' }; }
}
