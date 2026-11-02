import { Component, Input } from '@angular/core';

// Stroke icons drawn on a 24×24 grid. Paths are static strings, never user input.
const ICONS: Record<string, string> = {
  camera: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h9A1.5 1.5 0 0 1 15 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 3 16.5Zm12 3 6-3.5v10l-6-3.5',
  ticket: 'M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2.5a2.5 2.5 0 0 0 0 5V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2.5a2.5 2.5 0 0 0 0-5Zm10-2v14',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-2.5-11.5a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.2-2.5 3.9m0 3h.01',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5m5 5H4',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-14v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 2-4-4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v4l2.5 2.5',
  refresh: 'M20 11a8 8 0 0 0-14.8-3.5M4 4v4h4m-4 5a8 8 0 0 0 14.8 3.5M20 20v-4h-4',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  back: 'M19 12H5m6 6-6-6 6-6',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5v-4.5M12 8h.01',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  pin: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  expand: 'M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5',
  coins: 'M9 11c3.3 0 6-1.3 6-3s-2.7-3-6-3-6 1.3-6 3 2.7 3 6 3Zm-6-3v4c0 1.7 2.7 3 6 3s6-1.3 6-3V8m-12 4v4c0 1.7 2.7 3 6 3 1.2 0 2.3-.2 3.2-.5M15 12.3c.6-.2 1.3-.3 2-.3 2.2 0 4 .9 4 2s-1.8 2-4 2-4-.9-4-2m0 0v4c0 1.1 1.8 2 4 2s4-.9 4-2v-4',
  eye: 'M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0Zm0 1H4v2a3 3 0 0 0 4 2.8M16 5h4v2a3 3 0 0 1-4 2.8M12 13v4m-4 3h8m-6-3h4',
  chart: 'M4 20V4m0 16h16M8 16v-4m4 4V8m4 8v-6',
  shield: 'M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6Zm-3 9 2 2 4-4',
  alert: 'M12 4 2.5 20h19Zm0 6v4m0 3h.01',
  grid: 'M4 4h7v7H4Zm9 0h7v7h-7ZM4 13h7v7H4Zm9 0h7v7h-7Z',
  play: 'M7 4.5v15l12.5-7.5Z',
  external: 'M14 4h6v6m0-6-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'
};

@Component({
  selector: 'app-icon', standalone: true,
  template: `<svg viewBox="0 0 24 24" [attr.width]="size" [attr.height]="size" aria-hidden="true" focusable="false"><path [attr.d]="path"></path></svg>`,
  styles: [`:host{display:inline-flex;flex-shrink:0;line-height:0}svg{fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}`]
})
export class IconComponent {
  @Input({ required: true }) name!: string;
  @Input() size = 18;
  get path(): string { return ICONS[this.name] ?? ''; }
}
