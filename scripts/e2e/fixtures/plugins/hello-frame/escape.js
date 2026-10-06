// The extension's own page tries what its frame's policy refuses (R1): an
// inline script (above) and a host it didn't declare.
window.__escape = { violations: [], inlineRan: !!window.__inlineRan };
document.addEventListener('securitypolicyviolation', e => window.__escape.violations.push(`${e.violatedDirective} ${e.blockedURI}`));
window.__escape.fetch = fetch('https://evil.example.org/escape').then(r => `ok ${r.status}`, () => 'failed');
