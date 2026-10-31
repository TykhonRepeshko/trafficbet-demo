import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { sessionInterceptor } from './services/session.interceptor';
export const httpProviders = provideHttpClient(withInterceptors([sessionInterceptor]));
