import { NgIf } from '@angular/common';
import { Component, Input } from '@angular/core';
import { CountingSnapshot } from '../models';

@Component({ selector: 'app-counting-rules', standalone: true, imports: [NgIf], template: `
  <details *ngIf="snapshot?.definition as rule" class="small-note"><summary>Counting rules · version {{ snapshot?.version }}</summary>
    <p><strong>{{ rule.label }}</strong><br>{{ rule.notes }}</p>
    <p>Included classes: {{ rule.classes.join(', ') }}. Directions: {{ rule.directions.join(', ').replaceAll('_', ' ') }}.<br>
    Line from ({{ rule.lineStart.x }}, {{ rule.lineStart.y }}) to ({{ rule.lineEnd.x }}, {{ rule.lineEnd.y }}) in normalized image coordinates. A is the negative side of the oriented line, B the positive side.</p>
    <svg viewBox="0 0 100 60" width="200" height="120" role="img" aria-label="Published counting line in image coordinates"><rect width="100" height="60" fill="currentColor" opacity="0.07"/><line [attr.x1]="rule.lineStart.x * 100" [attr.y1]="rule.lineStart.y * 60" [attr.x2]="rule.lineEnd.x * 100" [attr.y2]="rule.lineEnd.y * 60" stroke="#f36e43" stroke-width="1.2"/></svg>
    <p>Bottom-centre anchor; first allowed crossing per tracked vehicle in [start, end), using verified capture UTC. Line touches and stationary vehicles do not count. Trailers belong to the towing vehicle. Unverifiable intervals must be reviewed or refunded.</p>
  </details>
  <p *ngIf="snapshot && !snapshot.definition" class="small-note">Legacy manual rules: {{ snapshot.publishedTitle }}. No calibrated counting configuration was recorded for this round.</p>
` })
export class CountingRulesComponent { @Input() snapshot?: CountingSnapshot; }
