// Probes the sandbox and the SDK; scripts/e2e/frames.cjs reads window.__results.
import atmos from 'atmos-sdk';

const results = window.__results = { surface: atmos.surface.type, presentation: atmos.surface.presentation };
document.body.innerHTML = `
  <main style="padding:32px;display:grid;gap:12px">
    <h2 style="margin:0;font-weight:500">Hello from a sandboxed frame</h2>
    <p style="margin:0;color:rgba(var(--ink-rgb),.6)">${atmos.extension.kind} · ${atmos.extension.id} · ${atmos.extension.tier}</p>
    <div id="visits"></div>
  </main>`;

// State shared by this extension's frames and saved by Atmos.
const saved = await atmos.state.get();
const visits = (saved.visits ?? 0) + 1;
await atmos.state.update({ visits });
results.visits = visits;
document.getElementById('visits').textContent = `Opened ${visits} time(s)`;

// Isolation: none of these should be reachable.
try { results.parent = parent.document.title; } catch { results.parent = 'blocked'; }
results.windowAtmos = typeof window.atmos;
results.windowAtmosCore = typeof window.atmosCore;
results.ink = getComputedStyle(document.documentElement).getPropertyValue('--ink-rgb').trim();

// SDK calls: a declared service works, undeclared targets are refused.
results.greet = await atmos.call('service:hello-service', 'greet', 'Sam').catch(e => `ERR ${e.message}`);
results.invokeUndeclared = await atmos.invoke('plugin:audio-player', 'anything').catch(e => `${e.name}: ${e.message}`);
results.notifyUndeclared = await atmos.notifications.show({ title: 'Hello' }).then(shown => `shown ${shown}`, e => e.name);
results.listenUndeclared = await new Promise(resolve => {
  const origError = console.error;
  console.error = (...args) => { console.error = origError; resolve(args.join(' ')); };
  atmos.events.on('audio-player:changed', () => {});
  setTimeout(() => resolve('no error'), 1000);
});

// CSP: only api.example.net was declared.
results.csp = [];
document.addEventListener('securitypolicyviolation', e => results.csp.push(`${e.violatedDirective} ${e.blockedURI}`));
const tryFetch = url => fetch(url).then(r => `ok ${r.status}`, () => 'blocked');
results.fetchUndeclared = await tryFetch('https://evil.example.org/x');
results.fetchResource = await tryFetch('atmos-resource://audio-player-media/anything');
results.fetchAppShell = await tryFetch('atmos-app://local/index.html');
results.fetchPluginScheme = await tryFetch('atmos-plugin://audio-player/panel.js');
results.fetchFirstPartyFrame = await tryFetch('atmos-ext://first-party/plugins/audio-player/panel.js');
results.popup = String(window.open('https://example.com'));
results.localStorage = (() => { try { localStorage.x = '1'; return 'ok'; } catch (e) { return e.name; } })();

// Events: emit our own, hear it back.
results.event = await new Promise(resolve => {
  const off = atmos.events.on('ping', payload => { off(); resolve(payload); });
  setTimeout(() => atmos.events.emit('ping', { n: 1 }), 100);
  setTimeout(() => resolve('timeout'), 2000);
});

// A library service imported into this frame.
try {
  const metadata = await import(await atmos.library('service:media-metadata', 'renderer.js'));
  results.library = typeof metadata.readTags === 'function' && typeof metadata.setInvoke === 'function' ? 'ok' : 'ERR missing exports';
} catch (error) {
  results.library = `ERR ${error.message}`;
}

// A context menu drawn by Atmos.
document.addEventListener('contextmenu', event => {
  event.preventDefault();
  atmos.contextMenu.open(event.clientX, event.clientY, [
    { type: 'heading', label: 'Hello Frame' },
    { id: 'say', label: 'Say hello', run: () => { results.menuRan = true; } },
    { id: 'other', label: 'Something else' },
  ]).then(choice => { results.menuChoice = choice; });
});
results.done = true;
