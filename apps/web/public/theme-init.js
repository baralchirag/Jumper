// Apply the theme before first paint to avoid a flash. A file rather than an inline script, so the
// Content-Security-Policy can forbid inline scripts entirely.
(function () {
  try {
    var t = localStorage.getItem('jumper-theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (e) {}
})();
