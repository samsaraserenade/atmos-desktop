'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const frames = require('./extension-frames.cjs');

const entry = (tier, extra = {}) => ({ id: 'hello', kind: 'plugin', tier, manifest: {}, ...extra });

test('runtime: system services in the page, first-party libraries in their consumers, everything else in frames', () => {
  assert.equal(frames.resolveRuntime(entry('system', { manifest: { runtime: 'frame' } })), 'page');
  assert.equal(frames.resolveRuntime(entry('third-party', { manifest: { runtime: 'page' } })), 'frame');
  assert.equal(frames.resolveRuntime(entry('first-party')), 'frame', 'no page runtime for extensions any more');
  assert.equal(frames.resolveRuntime(entry('first-party', { manifest: { runtime: 'page' } })), 'frame');
  assert.equal(frames.resolveRuntime(entry('first-party', { kind: 'service', manifest: { library: true } })), 'library');
  assert.equal(frames.resolveRuntime(entry('third-party', { kind: 'service', manifest: { library: true } })), 'frame');
});

test('origins: one per third-party extension, one shared by first-party', () => {
  assert.equal(frames.frameOrigin(entry('third-party')), 'atmos-ext://plugin-hello');
  assert.equal(frames.frameOrigin(entry('third-party', { kind: 'service' })), 'atmos-ext://service-hello');
  assert.equal(frames.frameOrigin(entry('first-party')), 'atmos-ext://first-party');
});

test('isolation: a first-party extension may ask for an origin of its own', () => {
  const isolated = entry('first-party', { manifest: { runtime: 'frame', isolation: 'origin' } });
  assert.equal(frames.frameOrigin(isolated), 'atmos-ext://first-party-plugin-hello');
  assert.equal(frames.frameOrigin(entry('first-party', { kind: 'service', manifest: { isolation: 'origin' } })), 'atmos-ext://first-party-service-hello');
  // Only first-party: a third-party extension is isolated already, and can't pick a first-party host.
  assert.equal(frames.frameOrigin(entry('third-party', { manifest: { isolation: 'origin' } })), 'atmos-ext://plugin-hello');
  assert.equal(frames.frameOrigin(entry('first-party', { manifest: { isolation: 'yes' } })), 'atmos-ext://first-party');
});

test('isolation: only declared, isolated extensions clean up the shared origin', () => {
  const legacyStorage = { sharedOriginIndexedDB: ['matrix-js-sdk*', 'exact-name', 'ab*', '*', 'x*y'] };
  assert.deepEqual(frames.sharedOriginCleanupPatterns(entry('first-party', { manifest: { isolation: 'origin', legacyStorage } })), ['matrix-js-sdk*', 'exact-name']);
  assert.deepEqual(frames.sharedOriginCleanupPatterns(entry('first-party', { manifest: { legacyStorage } })), []);
  assert.deepEqual(frames.sharedOriginCleanupPatterns(entry('third-party', { manifest: { isolation: 'origin', legacyStorage } })), []);
});

test('isolation: deleting shared copies runs as a remove request to the shared origin\'s frame', () => {
  const script = frames.storageHostScript({ from: 'atmos-ext://first-party', remove: { indexedDB: ['matrix-js-sdk*'], localStorage: [] } });
  assert.match(script, /"matrix-js-sdk\*"/);
  assert.match(script, /atmosMove: 'remove'/);
  assert.doesNotThrow(() => new Function(`return ${script}`));
});

test('CSP allows only declared hosts and never other Atmos schemes', () => {
  const csp = frames.frameCsp({ permissions: { network: ['api.example.net', '*.cdn.example'] }, inlineScriptHashes: ['abc'] });
  const directive = name => csp.split('; ').find(part => part.startsWith(`${name} `));
  for (const source of ['https://api.example.net', 'http://api.example.net', 'wss://api.example.net', 'ws://api.example.net']) {
    assert.ok(directive('connect-src').split(' ').includes(source), source);
  }
  assert.match(directive('connect-src'), /https:\/\/\*\.cdn\.example/);
  assert.equal(directive('script-src'), "script-src 'self' 'sha256-abc'");
  assert.equal(directive('frame-src'), "frame-src 'none'");
  assert.doesNotMatch(csp, /atmos-(app|plugin|service|resource)/);
  assert.match(frames.frameCsp({ permissions: { network: ['*'] } }), /connect-src 'self' https: http: wss: ws:/);
  assert.match(frames.frameCsp({ permissions: {} }), /connect-src 'self';/);
  assert.match(frames.frameCsp({ permissions: {}, libraryOrigins: ['atmos-ext://first-party'] }), /script-src 'self' atmos-ext:\/\/first-party/);
  const withResources = frames.frameCsp({ permissions: {}, resourceProviders: ['media-library', 'bad provider'] });
  for (const name of ['img-src', 'media-src', 'connect-src']) {
    assert.match(withResources, new RegExp(`${name} [^;]*atmos-resource://media-library`), name);
  }
  assert.doesNotMatch(withResources, /bad provider|script-src[^;]*atmos-resource/);
});

test('frames are delegated only the browser features they declare', () => {
  assert.equal(frames.framePermissionsPolicy({}), 'autoplay; clipboard-write; fullscreen');
  assert.equal(frames.framePermissionsPolicy({ browser: ['geolocation', 'media'] }), 'autoplay; clipboard-write; fullscreen; geolocation; camera; microphone');
});

test('contributions come from the manifest or convention, as plain text and files only', () => {
  const files = ['panel.js', 'sidebar.js', 'extra-sidebar.js', 'icon.svg', 'boot.js'];
  const conventional = frames.describeContributions(entry('third-party', { manifest: { displayName: 'Hi <b>there</b>' } }), files);
  assert.deepEqual(conventional.map(c => [c.surface, c.id, c.entry, c.label]), [
    ['panel', 'hello', 'panel.js', 'Hi bthere/b'],
    ['sidebar', 'hello', 'sidebar.js', 'Hi bthere/b'],
    ['boot', 'hello', 'boot.js', 'Hi bthere/b'],
  ]);

  const declared = frames.describeContributions(entry('third-party', {
    manifest: {
      contributes: {
        panel: { label: 'Hello', icon: 'icon.svg', default: true },
        sidebar: [{ label: 'One' }, { id: 'Two!', entry: 'extra-sidebar.js', label: 'Two' }],
        settings: { entry: 'missing.js' },
        boot: false,
      },
    },
  }), files);
  assert.deepEqual(declared.map(c => [c.surface, c.id, c.entry, c.icon, c.default]), [
    ['panel', 'hello', 'panel.js', 'icon.svg', true],
    ['sidebar', 'hello', 'sidebar.js', null, false],
    ['sidebar', 'hello-two', 'extra-sidebar.js', null, false],
  ]);
});

test('settings show on the Appearance page, an official web extension\'s (Atmos Browser) on the Browser page', () => {
  const files = ['settings.js'];
  const category = (tier, permissions) => frames.describeContributions(entry(tier, { manifest: { permissions } }), files)
    .find(c => c.surface === 'settings').category;
  assert.equal(category('first-party', {}), 'Appearance');
  assert.equal(category('first-party', { web: true }), 'Browser');
  assert.equal(category('third-party', { web: true }), 'Appearance', 'a community extension never gets the browser\'s page');
  assert.equal(category('third-party', {}), 'Appearance');
});

test('drawers and boot keys are first-party; panel keys are ignored', () => {
  const files = ['panel.js', 'sidebar.js', 'boot.js'];
  const make = (tier, panel) => frames.describeContributions(entry(tier, { manifest: { contributes: { panel, sidebar: {}, boot: { keys: ['Space'] } } } }), files);
  const [panel, , boot] = make('first-party', { shortcut: '#', shortcutToggles: true, drawer: { bar: 60, keys: true } });
  assert.equal(panel.shortcut, undefined, 'panel keys are gone (Atmos 0.19.1)');
  assert.equal(panel.shortcutToggles, undefined);
  assert.deepEqual(panel.drawer, { bar: 60, keys: true });
  assert.deepEqual(boot.keys, ['Space']);
  assert.equal(panel.fileDrops, undefined, 'file drops are gone (SDK 1.0)');
  const [thirdPanel, , thirdBoot] = make('third-party', { drawer: { bar: 60, keys: true } });
  assert.equal(thirdPanel.drawer, null, 'a drawer takes the whole workspace\'s wheel and typing: official only');
  assert.deepEqual(thirdBoot.keys, []);
});

test('first-party surfaces may keep the id they had before frames', () => {
  const files = ['panel.js', 'sidebar.js', 'watch.js'];
  const manifest = { contributes: {
    panel: { legacyId: 'old-panel' },
    sidebar: [{ legacyId: 'old-widget' }, { id: 'watch', entry: 'watch.js', legacyId: 'old-list' }],
  } };
  const ids = tier => frames.describeContributions(entry(tier, { manifest }), files).map(c => c.id);
  assert.deepEqual(ids('first-party'), ['old-panel', 'old-widget', 'old-list']);
  assert.deepEqual(ids('third-party'), ['hello', 'hello', 'hello-watch'], 'third-party ids always come from the extension');
  const bad = frames.describeContributions(entry('first-party', { manifest: { contributes: { panel: { legacyId: 'Bad Id!' } } } }), files);
  assert.equal(bad[0].id, 'hello');
});

test('widgets name their default panels; panels ask for Core-drawn glass', () => {
  const files = ['panel.js', 'sidebar.js'];
  const manifest = { contributes: {
    panel: { glass: true, showIn: ['x'] },
    sidebar: { showIn: ['hello', 'hello', 'Bad Id!', 7], glass: true },
  } };
  const [panel, sidebar] = frames.describeContributions(entry('first-party', { manifest }), files);
  assert.equal(panel.glass, true);
  assert.equal(panel.showIn, null, 'only widgets have default panels');
  assert.deepEqual(sidebar.showIn, ['hello']);
  assert.equal(sidebar.glass, false, 'widgets sit on the sidebar\'s own glass');
  const [plainPanel, plainSidebar] = frames.describeContributions(entry('first-party', { manifest: { contributes: { panel: {}, sidebar: {} } } }), files);
  assert.equal(plainPanel.glass, false);
  assert.deepEqual(plainSidebar.showIn, ['hello'], 'a widget shows beside its own panel by default');
  const [, everywhere] = frames.describeContributions(entry('first-party', { manifest: { contributes: { panel: {}, sidebar: { showIn: [] } } } }), files);
  assert.deepEqual(everywhere.showIn, [], '"showIn": [] keeps a widget everywhere');
  const [legacyPanel, legacyWidget] = frames.describeContributions(entry('first-party', { manifest: { contributes: { panel: { legacyId: 'old-panel' }, sidebar: {} } } }), files);
  assert.deepEqual(legacyWidget.showIn, [legacyPanel.id], 'the default follows the panel\'s own id');
  const [widgetOnly] = frames.describeContributions(entry('first-party', { manifest: { contributes: { sidebar: {} } } }), ['sidebar.js']);
  assert.equal(widgetOnly.showIn, null, 'a widget with no panel of its own shows everywhere');
});

test('a library service contributes no surfaces or boot frame, whatever it ships', () => {
  const files = ['panel.js', 'sidebar.js', 'settings.js', 'boot.js', 'api.js'];
  const library = entry('third-party', { kind: 'service', manifest: { library: true, contributes: { panel: {}, boot: {} } } });
  assert.equal(frames.isLibrary(library), true);
  assert.deepEqual(frames.describeContributions(library, files), []);
  // "library" means nothing on a plugin.
  assert.equal(frames.isLibrary(entry('third-party', { manifest: { library: true } })), false);
});

test('paths outside the extension or in private folders are refused', () => {
  assert.equal(frames.safeRelative('src/panel.js'), 'src/panel.js');
  assert.equal(frames.safeRelative('../other/panel.js'), null);
  assert.equal(frames.safeRelative('/etc/passwd'), null);
  assert.equal(frames.safeRelative('data/keys.json'), null);
  assert.equal(frames.safeRelative('src/../../x.js'), null);
  assert.equal(frames.safeRelative('.git/config'), null);
});

async function bridgeModule() {
  return import(pathToFileURL(path.join(__dirname, 'extension-bridge.js')).href);
}

function harness(extension, surface = { type: 'panel' }) {
  const posted = [];
  const store = {};
  const services = new Map();
  const listeners = new Map();
  const deps = {
    state: { get: () => ({ ...store }), set: (_ext, value) => { Object.keys(store).forEach(k => delete store[k]); Object.assign(store, value); } },
    events: {
      emit: (name, payload) => (listeners.get(name) || []).forEach(fn => fn(payload)),
      on: (name, fn) => { listeners.set(name, [...(listeners.get(name) || []), fn]); return () => {}; },
    },
    appearance: () => ({ vars: {} }),
    invokeMain: async (stamp, kind, id, channel, ...args) => ({ caller: stamp.caller, kind, id, channel, args }),
    services,
    libraryBase: id => (id === 'plotting' ? 'atmos-ext://first-party/services/plotting/' : null),
    openMenu: async () => 'x',
  };
  return { posted, store, services, deps, extension, surface };
}

async function request(bridge, posted, method, ...args) {
  const id = Math.random();
  await bridge.receive({ id, method, args });
  const reply = posted.find(message => message.reply === id);
  if (reply.error) throw Object.assign(new Error(reply.error.message), { name: reply.error.name });
  return reply.result;
}

test('bridge: state, events and permission checks', async () => {
  const { createExtensionBridge } = await bridgeModule();
  const h = harness({
    id: 'hello', kind: 'plugin', tier: 'third-party', permissions: { invokes: ['service:plotting', 'service:helper'] },
    // What the others share with it (worked out in the main process).
    frame: { reach: { 'service:helper': { ipc: ['lookup'], events: ['ready'], methods: [], resources: [] } } },
  });
  const bridge = createExtensionBridge({ extension: h.extension, surface: h.surface, post: m => h.posted.push(m), deps: h.deps });
  const call = (method, ...args) => request(bridge, h.posted, method, ...args);

  await call('state.update', { a: 1 });
  await call('state.update', { b: 2 });
  assert.deepEqual(await call('state.get'), { a: 1, b: 2 });
  await assert.rejects(call('state.set', [1, 2]), /must be an object/);
  await assert.rejects(call('state.set', { big: 'x'.repeat(1024 * 1024) }), /larger than 1 MB/);

  await assert.rejects(call('invoke', 'plugin:notes', 'x'), /not permitted to invoke plugin:notes/);
  assert.deepEqual(await call('invoke', 'plugin:hello', 'own', 1), { caller: 'plugin:hello', kind: 'plugin', id: 'hello', channel: 'own', args: [1] });
  await assert.rejects(call('invoke', 'notes', 'x'), /is not an extension/);
  // Another extension's handlers: only those it shares, and the call says who's asking.
  assert.deepEqual(await call('invoke', 'service:helper', 'lookup', 2), { caller: 'plugin:hello', kind: 'service', id: 'helper', channel: 'lookup', args: [2] });
  await assert.rejects(call('invoke', 'service:helper', 'read-any-file', '/etc/passwd'), /doesn't share its 'read-any-file' handler with community extensions/);
  await assert.rejects(call('invoke', 'service:plotting', 'x'), /doesn't share/);

  assert.equal(await call('library.url', 'service:plotting', 'api.js'), 'atmos-ext://first-party/services/plotting/api.js');
  await assert.rejects(call('library.url', 'service:plotting', '../../x.js'), /relative path/);
  await assert.rejects(call('library.url', 'service:helper', 'x.js'), /not a library/);

  await call('events.subscribe', 'ping');
  await call('events.emit', 'ping', 7);
  assert.deepEqual(h.posted.find(m => m.topic === 'event:ping'), { topic: 'event:ping', payload: 7 });
  await assert.rejects(call('events.emit', 'notes:changed', 1), /own events/);
  await assert.rejects(call('events.subscribe', 'notes:changed'), /not permitted to listen/);
  await call('events.subscribe', 'helper:ready');
  await assert.rejects(call('events.subscribe', 'helper:secrets'), /doesn't share its 'secrets' events/);
  await assert.rejects(call('main.subscribe', 'service:helper', 'secrets'), /doesn't share its 'secrets' events/);

  await assert.rejects(call('services.expose', ['x']), /only boot\.js can expose/);
  await assert.rejects(call('legacy.readIndexedDB', 'anything'), /legacy databases/);
  await assert.rejects(call('nope'), /unknown request/);
});

test('bridge: services expose methods from boot frames and callers need permission', async () => {
  const { createExtensionBridge } = await bridgeModule();
  const serviceHarness = harness({ id: 'helper', kind: 'service', tier: 'third-party', permissions: {} }, { type: 'boot' });
  const service = createExtensionBridge({ extension: serviceHarness.extension, surface: serviceHarness.surface, post: m => serviceHarness.posted.push(m), deps: serviceHarness.deps });
  await request(service, serviceHarness.posted, 'services.expose', ['greet']);
  const registered = serviceHarness.services.get('service:helper');
  assert.deepEqual(registered.methods, ['greet']);

  // A caller that declared the service reaches it; the frame answers.
  const caller = harness({ id: 'hello', kind: 'plugin', tier: 'third-party', permissions: { invokes: ['service:helper'] }, frame: { reach: { 'service:helper': { ipc: [], events: [], methods: ['greet', 'secret'], resources: [] } } } });
  caller.deps.services = serviceHarness.services;
  const callerBridge = createExtensionBridge({ extension: caller.extension, surface: caller.surface, post: m => caller.posted.push(m), deps: caller.deps });
  const pending = request(callerBridge, caller.posted, 'call', 'service:helper', 'greet', 'Sam');
  await new Promise(resolve => setImmediate(resolve));
  const outgoing = serviceHarness.posted.find(m => m.call !== undefined);
  assert.deepEqual([outgoing.method, outgoing.args], ['greet', ['Sam']]);
  await service.receive({ callReply: outgoing.call, result: 'Hello, Sam' });
  assert.equal(await pending, 'Hello, Sam');
  await assert.rejects(request(callerBridge, caller.posted, 'call', 'service:helper', 'secret'), /does not expose 'secret'/);

  const stranger = harness({ id: 'other', kind: 'plugin', tier: 'third-party', permissions: {} });
  stranger.deps.services = serviceHarness.services;
  const strangerBridge = createExtensionBridge({ extension: stranger.extension, surface: stranger.surface, post: m => stranger.posted.push(m), deps: stranger.deps });
  await assert.rejects(request(strangerBridge, stranger.posted, 'call', 'service:helper', 'greet'), /not permitted to call/);

  // Declared, but the service doesn't share that method with it.
  const unshared = harness({ id: 'nosy', kind: 'plugin', tier: 'third-party', permissions: { invokes: ['service:helper'] }, frame: { reach: { 'service:helper': { ipc: [], events: [], methods: [], resources: [] } } } });
  unshared.deps.services = serviceHarness.services;
  const unsharedBridge = createExtensionBridge({ extension: unshared.extension, surface: unshared.surface, post: m => unshared.posted.push(m), deps: unshared.deps });
  await assert.rejects(request(unsharedBridge, unshared.posted, 'call', 'service:helper', 'greet'), /doesn't share its 'greet' method/);

  service.dispose();
  assert.equal(serviceHarness.services.has('service:helper'), false);
});

test('storage moves: only isolated extensions that declare what they take, as names or long-enough prefixes', () => {
  const isolated = legacyStorage => entry('first-party', { manifest: { isolation: 'origin', legacyStorage } });
  assert.deepEqual(frames.sharedOriginMove(isolated({ sharedOrigin: { indexedDB: ['finance-assets', 'x*', '*'], localStorage: ['finance:state:*', 'finance:state:*'] } })),
    { indexedDB: ['finance-assets'], localStorage: ['finance:state:*'] });
  assert.equal(frames.sharedOriginMove(isolated({})), null, 'nothing declared: nothing to move');
  assert.equal(frames.sharedOriginMove(isolated({ sharedOrigin: { indexedDB: [] } })), null);
  assert.equal(frames.sharedOriginMove(entry('first-party', { manifest: { legacyStorage: { sharedOrigin: { indexedDB: ['a-db'] } } } })), null, 'not isolated: it stays');
  assert.equal(frames.sharedOriginMove(entry('third-party', { manifest: { isolation: 'origin', legacyStorage: { sharedOrigin: { indexedDB: ['a-db'] } } } })), null);
});

test('storage moves: an extension whose move failed runs from the shared origin that session', () => {
  const finance = entry('first-party', { manifest: { isolation: 'origin' } });
  assert.equal(frames.frameOrigin(finance), 'atmos-ext://first-party-plugin-hello');
  assert.equal(frames.frameOrigin({ ...finance, originFallback: true }), 'atmos-ext://first-party');
  assert.equal(frames.frameOrigin(entry('third-party', { originFallback: true })), 'atmos-ext://plugin-hello', 'third-party origins never change');
});

test('storage moves: Core serves its move pages with a policy that allows only its own script', () => {
  assert.match(frames.moveDocument('import'), /src="\/__atmos\/move\.js" data-role="import"/);
  assert.match(frames.moveDocument('anything'), /data-role="export"/);
  assert.equal(frames.moveCsp('import'), "default-src 'none'; script-src 'self'");
  assert.match(frames.moveCsp('export'), /frame-src atmos-ext:/);
  const script = frames.storageHostScript({ from: 'atmos-ext://first-party', to: 'atmos-ext://first-party-plugin-x', spec: { indexedDB: ['a'], localStorage: [] } });
  assert.match(script, /"atmos-ext:\/\/first-party-plugin-x"/);
  assert.doesNotThrow(() => new Function(`return ${script}`), 'the host script parses');
});

test('commands come from the manifest as plain text, never Atmos\'s own names, at most 30', () => {
  const declared = (commands, extra = {}) => frames.describeCommands(entry('third-party', { manifest: { contributes: { commands } }, ...extra }));
  assert.deepEqual(declared([
    { name: 'Go', args: 'room or <person>', about: 'Open one of\nyour rooms', takesArgs: true, suggests: true },
    { name: 'leave', about: 'Leave this room', suggests: 'yes' },
  ]), [
    { name: 'go', args: 'room or person', about: 'Open one of your rooms', takesArgs: true, suggests: true },
    { name: 'leave', args: '', about: 'Leave this room', takesArgs: false, suggests: false },
  ]);
  // Atmos's own names, bad names and repeats are left out.
  assert.deepEqual(declared([
    { name: 'switch' }, { name: 'settings' }, { name: 'sidebar' }, { name: 'extensions' },
    { name: 'two words' }, { name: '-x' }, { name: '9lives' }, { name: 'a'.repeat(31) }, { name: 42 }, null, 'go',
    { name: 'ok' }, { name: 'OK' },
  ]).map(command => command.name), ['ok']);
  assert.equal(declared(Array.from({ length: 40 }, (_, index) => ({ name: `c${index}` }))).length, 30);
  assert.equal(declared({ name: 'go' }).length, 0, 'not a list');
  assert.deepEqual(frames.describeCommands(entry('third-party')), []);
  assert.deepEqual(frames.describeCommands(entry('first-party', { kind: 'service', manifest: { library: true, contributes: { commands: [{ name: 'go' }] } } })), [], 'a library has no frames to run them');
  assert.equal(declared([{ name: 'x', about: 'y'.repeat(200) }])[0].about.length, 120);
  const aliased = declared([
    { name: 'play', aliases: ['pause', 'PAUSE', 'play', 'next', 'sidebar', 'Bad Name', 'resume', 'toggle', 'stop'] },
    { name: 'next', aliases: ['pause'] },
  ]);
  assert.deepEqual(aliased.map(command => command.aliases), [['pause', 'resume', 'toggle'], undefined],
    'its own and other commands\' names, Atmos\'s, bad ones and repeats dropped; at most 3');
  assert.deepEqual(frames.CORE_COMMAND_NAMES, ['sidebar', 'sidebar-side', 'settings', 'extensions', 'switch', 'widget', 'wallpaper', 'reload']);
});

test('bridge: a frame\'s calls to a main.cjs say which frame; Core hears when it goes (R17)', async () => {
  const { createExtensionBridge } = await bridgeModule();
  const h = harness({ id: 'hello', kind: 'plugin', tier: 'official', permissions: {} });
  const stamps = [];
  const closed = [];
  h.deps.invokeMain = async (stamp, kind, id, channel) => { stamps.push(stamp); return channel; };
  h.deps.frameClosed = frame => closed.push(frame);
  const open = () => {
    const posted = [];
    const bridge = createExtensionBridge({ extension: h.extension, surface: h.surface, post: m => posted.push(m), deps: h.deps });
    return { bridge, call: (method, ...args) => request(bridge, posted, method, ...args) };
  };
  const one = open();
  const two = open();
  assert.equal(await one.call('invoke', 'plugin:hello', 'own'), 'own');
  await one.call('invoke', 'plugin:hello', 'own');
  await two.call('invoke', 'plugin:hello', 'own');
  assert.equal(stamps[0].caller, 'plugin:hello');
  assert.equal(typeof stamps[0].frame, 'string');
  assert.equal(stamps[1].frame, stamps[0].frame, 'one id per frame');
  assert.notEqual(stamps[2].frame, stamps[0].frame);
  one.bridge.dispose();
  one.bridge.dispose();
  assert.deepEqual(closed, [stamps[0].frame], 'once');
  open().bridge.dispose();
  assert.equal(closed.length, 1, 'a frame that never called a main.cjs: nothing to tell');
});
