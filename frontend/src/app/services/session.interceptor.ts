import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

export const sessionInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  const sessionUserId = auth.user?.id, sessionGeneration = auth.sessionGeneration;
  return next(request).pipe(catchError((error: unknown) => {
    // A delayed response from an earlier account must not clear a newly signed-in session.
    if (error instanceof HttpErrorResponse && error.status === 401 && sessionUserId !== undefined &&
      auth.user?.id === sessionUserId && auth.sessionGeneration === sessionGeneration && request.url.startsWith(`${environment.apiUrl}/`) &&
      !request.url.startsWith(`${environment.apiUrl}/auth/`)) auth.expireSession();
    return throwError(() => error);
  }));
};
