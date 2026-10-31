import { JsonPipe, NgIf } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { timeout } from 'rxjs';
import { environment } from '../../environments/environment';
import { apiError } from '../services/ui-helpers';
@Component({ selector: 'app-operations', standalone: true, imports: [NgIf, JsonPipe], template: `<section class="panel" style="padding:24px"><h2>Operations</h2><p class="small-note">A manual snapshot of this local server and database. Delivery details are above. Request counters reset on API restart.</p><button class="button compact" type="button" [disabled]="loading" (click)="load()">Check operations</button><p *ngIf="error" class="error" role="alert">{{ error }}</p><p *ngIf="snapshot" [class.error]="snapshot.ledgerMismatches !== 0" [class.success]="snapshot.ledgerMismatches === 0">Ledger reconciliation: {{ snapshot.ledgerMismatches === 0 ? 'Balances match journal totals' : snapshot.ledgerMismatches + ' discrepancies — investigate' }}</p><pre *ngIf="snapshot" style="white-space:pre-wrap">{{ snapshot | json }}</pre></section>` })
export class OperationsComponent implements OnInit {
 private readonly http = inject(HttpClient); private readonly destroyRef = inject(DestroyRef); loading = false; error = ''; snapshot?: { ledgerMismatches: number; [key: string]: unknown };
 ngOnInit(): void { this.load(); }
 load(): void { if (this.loading) return; this.loading = true; this.error = ''; this.http.get<{ ledgerMismatches: number; [key: string]: unknown }>(`${environment.apiUrl}/admin/operations`, { withCredentials: true }).pipe(timeout(15_000), takeUntilDestroyed(this.destroyRef)).subscribe({ next: (data) => { this.loading = false; this.snapshot = data; }, error: (error) => { this.loading = false; this.error = apiError(error); } }); }
}
