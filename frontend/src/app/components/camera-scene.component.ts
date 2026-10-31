import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-camera-scene', standalone: true,
  template: `<div class="camera-scene" [class.scene-two]="variant % 3 === 2" [class.scene-three]="variant % 3 === 0" aria-hidden="true"><div class="map-grid"></div><div class="city-block block-one"></div><div class="city-block block-two"></div><div class="city-block block-three"></div><div class="city-block block-four"></div><div class="road"><div class="road-divider"></div><div class="road-dash dash-left"></div><div class="road-dash dash-right"></div><span class="car car-one"></span><span class="car car-two"></span><span class="car car-three"></span><span class="car car-four"></span><span class="car car-five"></span></div><div class="crossroad"></div><div class="camera-corner top-left"></div><div class="camera-corner bottom-right"></div><span class="scene-caption">ILLUSTRATED LOCATION / CAM 0{{ variant }}</span></div>`
})
export class CameraSceneComponent { @Input() variant = 1; }
