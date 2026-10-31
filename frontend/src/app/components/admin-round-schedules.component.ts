import { DOCUMENT, DatePipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { Component, DestroyRef, OnDestroy, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription, timeout } from 'rxjs';
import { RoundSchedule, RoundScheduleSettings, RoundScheduleSnapshot } from '../models';
import { ApiService } from '../services/api.service';
import { apiError } from '../services/ui-helpers';

@Component({
  selector: 'app-admin-round-schedules', standalone: true,
  imports: [DatePipe, DecimalPipe, NgFor, NgIf, FormsModule, RouterLink],
  template: `
    <section aria-labelledby="schedules-title">
      <div class="section-toolbar"><div><span class="eyebrow">RECURRING COUNTING INTERVALS</span><h2 id="schedules-title">Automatic rounds</h2><p class="muted small-note">Upcoming rounds are published in advance so members can predict the next round while an earlier one is locked or counting. Settings are saved in PostgreSQL.</p></div><button class="button compact" type="button" (click)="refresh()" [disabled]="refreshing || saving">{{ refreshing ? 'Updating…' : '↻ Refresh schedules' }}</button></div>
      <p class="schedule-explanation">Counting rounds run on a repeating cadence. Each entry deadline is placed before its count by the safety gap, so that gap does not delay the next counting window. The worker maintains two future rounds accepting predictions and refills the queue as deadlines pass. Completed rounds still require a verified result or a refund in <strong>Rounds</strong>. Archiving a camera pauses publication. Existing predictions and published terms are preserved.</p>
      <p class="small-note" *ngIf="snapshot">Status as of {{ snapshot.asOf | date:'MMM d, HH:mm:ss' }} · local time · updates every 10 seconds</p>
      <p class="error notice-block" *ngIf="error" role="alert">{{ error }} {{ snapshot ? 'The last loaded schedule is still shown; its status may be out of date.' : '' }}</p>
      <p class="success notice-block" *ngIf="message" role="status">{{ message }}</p>
      <p class="loading-state" *ngIf="refreshing && !snapshot" role="status">Loading automatic rounds…</p>
      <div class="schedule-grid" *ngIf="snapshot">
        <article class="schedule-card" *ngFor="let schedule of snapshot.schedules; trackBy: trackSchedule">
          <div class="schedule-heading"><div><span class="eyebrow">CAM / {{ schedule.streamId }}</span><h3>{{ schedule.streamTitle }}</h3></div><span class="tag neutral">{{ state(schedule) }}</span></div>
          <div class="schedule-cycle"><div><span>Regular counting cadence</span><strong>Every {{ schedule.entrySeconds + schedule.countingSeconds }} sec</strong></div><div><span>Count vehicles for</span><strong>{{ schedule.countingSeconds }} sec</strong></div><div><span>Entries close before count</span><strong>{{ schedule.leadSeconds }} sec</strong></div></div>
          <p class="schedule-rule">{{ schedule.countingRule }}</p>
          <div class="schedule-terms"><span>Threshold <strong>{{ schedule.threshold | number }}</strong></span><span>Over <strong>{{ schedule.oddsOver | number:'1.2-2' }}</strong></span><span>Under or equal <strong>{{ schedule.oddsUnder | number:'1.2-2' }}</strong></span></div>
          <p class="small-note" *ngIf="schedule.enabled && schedule.isActive && schedule.supported">Next queue refill due: {{ schedule.nextRunAt ? (schedule.nextRunAt | date:'MMM d, HH:mm:ss') : 'Within 10 seconds of saving' }}. The worker checks every 10 seconds; already published rounds keep their times and terms.</p>
          <p class="small-note" *ngIf="schedule.lastCheckedAt">Last worker check: {{ schedule.lastCheckedAt | date:'MMM d, HH:mm:ss' }}<span *ngIf="schedule.lastMarketId"> · Last automatic round #{{ schedule.lastMarketId }}</span></p>
          <p class="schedule-review" *ngIf="schedule.awaitingVerification">{{ schedule.awaitingVerification }} completed round(s) awaiting verification. Publication does not settle predictions.</p>
          <div class="row-actions"><button class="button compact" type="button" (click)="edit(schedule)" [disabled]="saving">Configure schedule</button><a class="text-button" *ngIf="schedule.isActive" [routerLink]="['/streams', schedule.streamId]">View camera ↗</a></div>
          <form *ngIf="editingId === schedule.streamId" class="form-grid two-columns schedule-editor" (ngSubmit)="settingsForm.valid && save()" #settingsForm="ngForm">
            <label class="check-field wide-field"><input name="enabled" type="checkbox" [(ngModel)]="draft.enabled" [disabled]="saving"> Publish rounds automatically</label>
            <p class="small-note wide-field" *ngIf="!schedule.isActive || !schedule.supported">Restore this camera and choose a continuous live source before enabling its schedule.</p>
            <label class="wide-field">Counting rule / zone<input name="countingRule" [(ngModel)]="draft.countingRule" required maxlength="160" [disabled]="saving"></label>
            <label>Vehicle threshold<input name="threshold" type="number" [(ngModel)]="draft.threshold" required min="0" max="100000000" step="1" [disabled]="saving"></label>
            <label>Pause / minimum entry notice, seconds<input name="entrySeconds" type="number" [(ngModel)]="draft.entrySeconds" required min="30" max="3600" step="1" [disabled]="saving"></label>
            <label>Safety gap, seconds<input name="leadSeconds" type="number" [(ngModel)]="draft.leadSeconds" required min="30" max="3600" step="1" [disabled]="saving"></label>
            <label>Counting interval, seconds<input name="countingSeconds" type="number" [(ngModel)]="draft.countingSeconds" required min="30" max="3600" step="1" [disabled]="saving"></label>
            <label>Over odds<input name="oddsOver" type="number" [(ngModel)]="draft.oddsOver" required min="1" max="100" step="0.01" [disabled]="saving"></label>
            <label>Under or equal odds<input name="oddsUnder" type="number" [(ngModel)]="draft.oddsUnder" required min="1" max="100" step="0.01" [disabled]="saving"></label>
            <p class="small-note wide-field">Regular cadence: a {{ draft.countingSeconds }}-second count plus a {{ draft.entrySeconds }}-second pause means a new count every {{ draft.entrySeconds + draft.countingSeconds }} seconds. The pause also sets the minimum notice before a new entry deadline. The {{ draft.leadSeconds }}-second safety gap is placed before each count and does not add to this cadence. Startup, downtime and already published windows can delay the first new count. Changes apply only to newly published rounds; existing rounds and stakes keep their terms. Disabling stops new publication, and restoring a camera resumes its enabled schedule.</p>
            <p class="error wide-field" *ngIf="saveError" role="alert">{{ saveError }}</p>
            <div class="row-actions wide-field"><button class="button primary compact" type="submit" [disabled]="saving || !settingsForm.valid || (draft.enabled && (!schedule.isActive || !schedule.supported))">{{ saving ? 'Saving…' : 'Save schedule' }}</button><button class="text-button" type="button" (click)="editingId = undefined" [disabled]="saving">Cancel</button></div>
          </form>
        </article>
      </div>
      <p class="empty-note" *ngIf="snapshot && !snapshot.schedules.length">Add a live camera before configuring a schedule.</p>
    </section>
  `,
  styles: [`
    .schedule-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
    .schedule-card{min-width:0;border:1px solid var(--line);background:var(--surface);border-radius:var(--radius);padding:24px}
    .schedule-heading{display:flex;justify-content:space-between;align-items:start;gap:12px}.schedule-heading h3{margin:9px 0 20px}
    .schedule-cycle{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:start;gap:16px;padding:17px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
    .schedule-cycle div{display:grid;gap:6px}.schedule-cycle strong{font-size:18px}.schedule-cycle span{font-size:11px;color:var(--muted)}
    .schedule-rule{margin:18px 0 12px;overflow-wrap:anywhere;font-size:12px}.schedule-terms{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:16px;font-size:11px;color:var(--muted)}.schedule-terms strong{display:block;color:var(--ink);margin-top:5px;font-size:16px}
    .schedule-explanation{font-size:12px;color:var(--muted);max-width:860px}.schedule-review{font-size:12px;border-left:3px solid var(--orange);padding-left:10px;color:var(--ink)}
    .schedule-editor{margin-top:20px;border-top:1px solid var(--line);padding-top:20px}
    @media(max-width:1100px){.schedule-grid{grid-template-columns:1fr}}@media(max-width:500px){.schedule-card{padding:17px}.schedule-heading{flex-wrap:wrap}.schedule-cycle{grid-template-columns:1fr;gap:14px}.schedule-cycle div{grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:12px}.schedule-cycle strong{font-size:16px}}
  `]
})
export class AdminRoundSchedulesComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  snapshot?: RoundScheduleSnapshot;
  refreshing = false;
  saving = false;
  error = '';
  saveError = '';
  message = '';
  editingId?: number;
  draft: RoundScheduleSettings = { enabled: false, countingRule: '', threshold: 3, oddsOver: 1.9, oddsUnder: 1.9, entrySeconds: 30, leadSeconds: 30, countingSeconds: 30 };
  private request?: Subscription;
  private timer?: number;
  private destroyed = false;
  private readonly visibilityChanged = (): void => { if (!this.document.hidden) this.refresh(); };

  ngOnInit(): void {
    this.refresh();
    this.timer = this.document.defaultView?.setInterval(() => this.refresh(), 10_000);
    this.document.addEventListener('visibilitychange', this.visibilityChanged);
  }
  ngOnDestroy(): void {
    this.destroyed = true; this.request?.unsubscribe();
    if (this.timer !== undefined) this.document.defaultView?.clearInterval(this.timer);
    this.document.removeEventListener('visibilitychange', this.visibilityChanged);
  }
  refresh(): void {
    if (this.destroyed || this.document.hidden || this.refreshing || this.saving) return;
    this.refreshing = true;
    this.request = this.api.roundSchedules().pipe(timeout(8000), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (value) => { this.snapshot = value; this.refreshing = false; this.error = ''; },
      error: (error) => { this.refreshing = false; this.error = apiError(error); }
    });
  }
  trackSchedule(_index: number, schedule: RoundSchedule): number { return schedule.streamId; }
  state(schedule: RoundSchedule): string {
    if (!schedule.isActive) return 'Camera archived';
    if (!schedule.supported) return 'Live source required';
    if (!schedule.enabled) return 'Disabled';
    if (!schedule.lastCheckedAt) return 'Starting';
    if (Date.parse(this.snapshot?.asOf ?? '') - Date.parse(schedule.lastCheckedAt) > 60_000) return 'Worker overdue';
    return 'Enabled';
  }
  edit(schedule: RoundSchedule): void {
    if (this.saving) return;
    this.editingId = schedule.streamId; this.saveError = ''; this.message = '';
    this.draft = { enabled: schedule.enabled, countingRule: schedule.countingRule, threshold: schedule.threshold, oddsOver: schedule.oddsOver, oddsUnder: schedule.oddsUnder, entrySeconds: schedule.entrySeconds, leadSeconds: schedule.leadSeconds, countingSeconds: schedule.countingSeconds };
  }
  save(): void {
    if (this.saving || this.editingId === undefined || this.destroyed) return;
    const p = { ...this.draft, countingRule: this.draft.countingRule.trim() };
    this.saveError = ''; this.message = '';
    if (!p.countingRule || new TextEncoder().encode(p.countingRule).length > 160 || /\p{Cc}/u.test(p.countingRule) ||
      !Number.isInteger(p.threshold) || p.threshold < 0 || p.threshold > 100000000 ||
      !Number.isInteger(p.entrySeconds) || p.entrySeconds < 30 || p.entrySeconds > 3600 ||
      !Number.isInteger(p.leadSeconds) || p.leadSeconds < 30 || p.leadSeconds > 3600 ||
      !Number.isInteger(p.countingSeconds) || p.countingSeconds < 30 || p.countingSeconds > 3600 ||
      [p.oddsOver, p.oddsUnder].some((n) => !Number.isFinite(n) || n < 1 || n > 100 || Math.abs(n * 100 - Math.round(n * 100)) > 0.000001)) {
      this.saveError = 'Check the counting rule, whole-number durations and threshold. Odds require up to two decimal places; the safety gap must be at least 30 seconds.'; return;
    }
    this.request?.unsubscribe(); this.refreshing = false; this.saving = true;
    this.api.saveRoundSchedule(this.editingId, p).pipe(timeout(8000), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving = false; this.editingId = undefined; this.message = 'Schedule saved. The worker checks every 10 seconds. Existing rounds keep their published terms.'; this.refresh(); },
      error: (error) => { this.saving = false; this.saveError = apiError(error); }
    });
  }
}
