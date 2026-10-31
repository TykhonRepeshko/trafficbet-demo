import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { previewInterceptor } from './preview/preview.interceptor';
import { sessionInterceptor } from './services/session.interceptor';
export const httpProviders = provideHttpClient(withInterceptors([sessionInterceptor, previewInterceptor]));
