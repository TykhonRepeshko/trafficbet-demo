/** Internal sign-in destinations with explicit, bounded context parameters. */
export function signInDestination(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  try {
    const url = new URL(raw, 'http://trafficbet.local');
    if (url.origin !== 'http://trafficbet.local' || url.pathname !== raw.split(/[?#]/)[0]) return '/';
    const path = url.pathname;
    if (!/^\/(?:bets|account|streams\/[1-9]\d*|admin(?:\/(?:preparation|media-lab|cameras(?:\/[1-9]\d*)?))?)$/.test(path)) return '/';
    const allowed = path === '/admin' ? ['tab'] : path === '/admin/preparation' ? ['stream', 'round'] : /^\/(?:admin\/cameras|streams)\/\d+$/.test(path) ? ['round'] : [];
    const entries: [string, string][] = [];
    url.searchParams.forEach((value, key) => entries.push([key, value]));
    for (const [key, value] of entries) {
      if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) return '/';
      if (key === 'tab' ? !['cameras', 'markets', 'schedules', 'bets', 'users', 'volume'].includes(value) : !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return '/';
    }
    const fragments = path === '/admin/preparation' ? ['#round-review', '#counting-rules', '#source-health', '#audit-history']
      : path === '/admin/cameras' ? ['#camera-directory', '#prediction-rounds']
      : /^\/admin\/cameras\/\d+$/.test(path) ? ['#selected-round'] : [];
    if (url.hash && !fragments.includes(url.hash)) return '/';
    return raw;
  } catch { return '/'; }
}
