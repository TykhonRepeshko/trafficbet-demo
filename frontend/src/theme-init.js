// A same-origin external script sets the palette before styles paint, under script-src 'self'.
(function () {
  var theme = null;
  try {
    var preference = window.localStorage.getItem('trafficbet.theme');
    if (preference === 'light' || preference === 'dark') theme = preference;
  } catch (_) {}
  if (!theme) {
    try { theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
    catch (_) { theme = 'light'; }
  }
  document.documentElement.setAttribute('data-theme', theme);
}());
