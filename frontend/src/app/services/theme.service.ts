import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

export type Theme = 'light' | 'dark';
export const themeStorageKey = 'trafficbet.theme';

function readPreference(browser: Window | null): Theme | null {
  try {
    const value = browser?.localStorage.getItem(themeStorageKey);
    return value === 'light' || value === 'dark' ? value : null;
  } catch { return null; }
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly browser = this.document.defaultView;
  private preference = readPreference(this.browser);
  private readonly system = this.systemPreference();
  readonly current = signal<Theme>('light');
  readonly isDark = computed(() => this.current() === 'dark');

  constructor() {
    this.apply(this.preference ?? (this.system?.matches ? 'dark' : 'light'));
    const systemChanged = (): void => {
      if (!this.preference) this.apply(this.system?.matches ? 'dark' : 'light');
    };
    const storageChanged = (event: StorageEvent): void => {
      if (event.key !== null && event.key !== themeStorageKey) return;
      // Read the actual local preference, rather than trusting an event payload.
      this.preference = readPreference(this.browser);
      this.apply(this.preference ?? (this.system?.matches ? 'dark' : 'light'));
    };
    this.system?.addEventListener('change', systemChanged);
    this.browser?.addEventListener('storage', storageChanged);
    inject(DestroyRef).onDestroy(() => {
      this.system?.removeEventListener('change', systemChanged);
      this.browser?.removeEventListener('storage', storageChanged);
    });
  }

  toggle(): void {
    this.preference = this.isDark() ? 'light' : 'dark';
    this.apply(this.preference);
    try { this.browser?.localStorage.setItem(themeStorageKey, this.preference); }
    catch { /* Private browsing or a full store must not prevent switching. */ }
  }

  private systemPreference(): MediaQueryList | null {
    try { return this.browser?.matchMedia('(prefers-color-scheme: dark)') ?? null; }
    catch { return null; }
  }

  private apply(theme: Theme): void {
    this.current.set(theme);
    this.document.documentElement.setAttribute('data-theme', theme);
  }
}
