import { NgFor, NgIf } from '@angular/common';
import { Component, Input } from '@angular/core';
import { LiveHighlightFrame } from '../models';
import { countedVehicleBoxes } from '../services/play-logic';

@Component({
  selector: 'app-counted-vehicles-overlay', standalone: true, imports: [NgFor, NgIf],
  template: `<svg *ngIf="mediaWidth > 0 && mediaHeight > 0" [attr.viewBox]="'0 0 ' + mediaWidth + ' ' + mediaHeight" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <g *ngFor="let box of boxes">
      <rect [attr.x]="box.x * mediaWidth" [attr.y]="box.y * mediaHeight" [attr.width]="box.width * mediaWidth" [attr.height]="box.height * mediaHeight" rx="3"></rect>
    </g>
  </svg>`,
  styles: [`:host{position:absolute;inset:0;pointer-events:none;z-index:2}svg{display:block;width:100%;height:100%;overflow:hidden}rect{fill:#22c55e20;stroke:#42f587;stroke-width:2;vector-effect:non-scaling-stroke}`]
})
export class CountedVehiclesOverlayComponent {
  @Input() frames?: LiveHighlightFrame[];
  @Input() captureTime: number | null = null;
  @Input() mediaWidth = 0;
  @Input() mediaHeight = 0;
  get boxes() { return countedVehicleBoxes(this.frames, this.captureTime); }
}
