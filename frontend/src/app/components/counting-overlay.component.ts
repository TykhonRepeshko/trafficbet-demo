import { NgIf } from '@angular/common';
import { Component, Input } from '@angular/core';
import { CountingDefinition, CountingSnapshot, PublicCountingGuide } from '../models';

@Component({
  selector: 'app-counting-overlay', standalone: true, imports: [NgIf],
  template: `
    <ng-container *ngIf="definition as rule">
      <svg [attr.viewBox]="'0 0 ' + guide!.width + ' ' + guide!.height" preserveAspectRatio="xMidYMid meet" role="img" [attr.aria-label]="label + ': ' + rule.label">
        <line class="line-outline" [attr.x1]="rule.lineStart.x * guide!.width" [attr.y1]="rule.lineStart.y * guide!.height" [attr.x2]="rule.lineEnd.x * guide!.width" [attr.y2]="rule.lineEnd.y * guide!.height"></line>
        <line class="counting-line" [attr.x1]="rule.lineStart.x * guide!.width" [attr.y1]="rule.lineStart.y * guide!.height" [attr.x2]="rule.lineEnd.x * guide!.width" [attr.y2]="rule.lineEnd.y * guide!.height"></line>
        <circle [attr.cx]="rule.lineStart.x * guide!.width" [attr.cy]="rule.lineStart.y * guide!.height" r="2.5" vector-effect="non-scaling-stroke"></circle>
        <circle [attr.cx]="rule.lineEnd.x * guide!.width" [attr.cy]="rule.lineEnd.y * guide!.height" r="2.5" vector-effect="non-scaling-stroke"></circle>
      </svg>
      <span class="line-caption" *ngIf="!compact">{{ label }}</span>
    </ng-container>
  `,
  styles: [`:host{position:absolute;inset:0;display:block;pointer-events:none;z-index:1}svg{width:100%;height:100%;display:block;overflow:hidden;opacity:.55}line{vector-effect:non-scaling-stroke;stroke-linecap:round}.line-outline{stroke:#071923;stroke-width:3}.counting-line{stroke:#57f1d0;stroke-width:1.5;stroke-dasharray:7 5}circle{fill:#57f1d0;stroke:#071923;stroke-width:1}.line-caption{position:absolute;top:12px;left:12px;max-width:calc(100% - 24px);padding:6px 9px;border-radius:5px;background:#071923e6;color:#cefff3;font:600 11px/1.4 system-ui,sans-serif}`]
})
export class CountingOverlayComponent {
  @Input() guide?: PublicCountingGuide;
  @Input() snapshot?: CountingSnapshot;
  @Input() mediaWidth = 0;
  @Input() mediaHeight = 0;
  @Input() compact = false;
  get definition(): CountingDefinition | undefined {
    const guide = this.guide;
    if (!guide || !Number.isFinite(guide.width) || !Number.isFinite(guide.height) || guide.width <= 0 || guide.height <= 0) return undefined;
    // Do not move a calibrated line onto a changed camera aspect ratio.
    if (this.mediaWidth > 0 && this.mediaHeight > 0 && Math.abs((this.mediaWidth / this.mediaHeight) / (guide.width / guide.height) - 1) > 0.01) return undefined;
    if (this.snapshot?.mode === 'versioned') {
      if (this.snapshot.sourceFingerprint !== guide.sourceFingerprint) return undefined;
      return this.valid(this.snapshot.definition) ? this.snapshot.definition : undefined;
    }
    return this.valid(guide.definition) ? guide.definition : undefined;
  }
  get label(): string {
    if (this.snapshot?.mode === 'versioned') return `Round counting line · v${this.snapshot.version}`;
    if (this.snapshot) return 'Preview line · round uses manual rules';
    return this.guide?.approved ? `Counting line · v${this.guide.version}` : 'Draft counting line · awaiting review';
  }
  private valid(rule?: CountingDefinition): boolean {
    return !!rule && [rule.lineStart, rule.lineEnd].every(point => !!point && [point.x, point.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  }
}
