// Probes SDK 1.0 from a developer folder; scripts/e2e/sdk.cjs reads window.__results.
import atmos from 'atmos-sdk';

const BUILD = 1; // sdk.cjs rewrites this line to check live reload
const results = window.__results = { build: BUILD, sdk: atmos.SDK_VERSION, extension: { ...atmos.extension } };
const settle = promise => promise.then(value => ({ ok: value }), error => ({ name: error.name, message: error.message }));
const text = response => response.text();

window.__atmos = atmos;
// atmos.fetch(): an answer with no CORS headers, which the frame's own fetch() couldn't read.
results.atmosFetch = await settle(atmos.fetch('https://api.test.example/no-cors').then(async r => ({ status: r.status, type: r.headers.get('content-type'), body: await r.json(), url: r.url })));
results.post = await settle(atmos.fetch('https://api.test.example/echo', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer probe' }, body: JSON.stringify({ hello: 'atmos' }),
}).then(r => r.json()));
results.redirected = await settle(atmos.fetch('https://api.test.example/hop').then(async r => ({ redirected: r.redirected, url: r.url, body: await text(r) })));
results.undeclared = await settle(atmos.fetch('https://elsewhere.example/'));
results.redirectUndeclared = await settle(atmos.fetch('https://api.test.example/away'));
// An address can't be declared (only public host names), so it is simply not allowed.
results.privateAddress = await settle(atmos.fetch('https://127.0.0.1/'));
results.plainHttp = await settle(atmos.fetch('http://api.test.example/'));
results.other = await settle(atmos.fetch('https://other.test.example/no-cors').then(r => r.status));
const controller = new AbortController();
const slow = settle(atmos.fetch('https://api.test.example/slow', { signal: controller.signal }));
setTimeout(() => controller.abort(), 50);
results.aborted = await slow;

// The location, read-only.
results.locationBefore = await settle(atmos.location.get());
atmos.location.onChange(value => { results.locationChanged = value; });

// Lifecycle: the cleanup leaves a mark the next frame can read.
results.signalAborted = atmos.lifecycle.signal.aborted;
results.cleanedUpBefore = localStorage.getItem('cleanedUp');
atmos.lifecycle.onCleanup(() => localStorage.setItem('cleanedUp', String(BUILD)));

// What went with SDK 1.0.
results.fileDrops = typeof atmos.surface.onFileDrop;
results.background = await settle(atmos.background());
results.done = true;
document.body.textContent = `SDK probe, build ${BUILD}`;
