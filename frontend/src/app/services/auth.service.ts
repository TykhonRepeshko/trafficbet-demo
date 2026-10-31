import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable, catchError, of, shareReplay, tap, timeout } from 'rxjs';
import { environment } from '../../environments/environment';
import { LoginResponse, User } from '../models';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly userSubject = new BehaviorSubject<User | null>(null);
  private restoration?: Observable<User | null>;
  private sessionVersion = 0;
  sessionExpired = false;
  get sessionGeneration(): number { return this.sessionVersion; }
  readonly user$ = this.userSubject.asObservable();
  get user(): User | null { return this.userSubject.value; }
  get isAdmin(): boolean { return this.user?.role === 'admin'; }
  login(email: string, password: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${environment.apiUrl}/auth/login`, { email, password }, { withCredentials: true })
      .pipe(tap(({ user }) => { this.sessionVersion++; this.updateUser(user); }));
  }
  register(email: string, displayName: string, password: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${environment.apiUrl}/auth/register`, { email, displayName, password }, { withCredentials: true })
      .pipe(tap(({ user }) => { this.sessionVersion++; this.updateUser(user); }));
  }
  logout(): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${environment.apiUrl}/auth/logout`, {}, { withCredentials: true })
      .pipe(tap(() => { this.sessionVersion++; this.sessionExpired = false; this.userSubject.next(null); }));
  }
  updateUser(user: User): void { this.sessionExpired = false; this.userSubject.next(user); }
  expireSession(): void { this.sessionVersion++; this.sessionExpired = true; this.userSubject.next(null); }
  refreshMe(): Observable<User> {
    const generation = this.sessionVersion;
    return this.http.get<User>(`${environment.apiUrl}/me`, { withCredentials: true }).pipe(tap((user) => {
      if (this.sessionVersion === generation) this.updateUser(user);
    }));
  }
  restore(): Observable<User | null> {
    this.restoration ??= this.refreshMe().pipe(timeout(5000), catchError(() => of(null)), shareReplay(1));
    return this.restoration;
  }
}
