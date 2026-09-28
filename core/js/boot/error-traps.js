// Loaded first by index.html (a file, not inline: the page's Content-Security-Policy
// allows no inline scripts). Logs load and runtime failures while Atmos starts.
// Runtime JS errors (syntax errors, thrown exceptions, etc.)
window.addEventListener('error', function(e) {
  console.log('[SYNTAX-TRAP] file=' + e.filename + ' line=' + e.lineno + ' col=' + e.colno + ' msg=' + e.message);
});

// Module/resource load failures — e.g. a <script type="module"> or an
// `import` inside one pointing at a path that 404s after a file move.
// These fire as a plain Event (no .message) on the failed element itself,
// and only reach window in the CAPTURE phase — they don't bubble.
window.addEventListener('error', function(e) {
  const el = e.target;
  if (el && el !== window && (el.src || el.href)) {
    console.log('[LOAD-TRAP] failed to load: ' + (el.src || el.href) + ' (tag=' + el.tagName + ')');
  }
}, true);

// Dynamic import() failures — e.g. import('./js/foo.js') where foo.js was
// moved/renamed. These reject a promise rather than throwing, so they only
// show up here, not in the error trap above.
window.addEventListener('unhandledrejection', function(e) {
  console.log('[IMPORT-TRAP] unhandled rejection: ' + (e.reason?.message || e.reason));
});
