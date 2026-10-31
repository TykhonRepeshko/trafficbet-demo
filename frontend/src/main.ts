import { inject, provideAppInitializer, provideZoneChangeDetection } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';

import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';
import { httpProviders } from './app/http.providers';
import { AuthService } from './app/services/auth.service';

bootstrapApplication(AppComponent, {
  providers: [
    httpProviders,
    provideZoneChangeDetection(),
    provideAppInitializer(() => firstValueFrom(inject(AuthService).restore())),
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ anchorScrolling: 'enabled', scrollPositionRestoration: 'enabled' }))
  ]
}).catch((error) => console.error(error));
