/**
 * The SDK contract: one script of SDK calls, run against the fake Atmos in
 * Node (scripts/sdk-contract.test.mjs) and against a real Atmos from a
 * developer folder (scripts/e2e/contract.cjs). Both compare what it reports
 * with expected.json beside this file, so the test kit (and the typings,
 * written from the same calls) can't drift from what Atmos does: an audio
 * state without `id`, a call the fake allows and Atmos refuses.
 *
 * It records shapes (key → type) and the values that matter, never timing.
 * `declared` says which extension it runs as:
 *   'all'   declares service:audio, service:wallpaper, service:location
 *           and "notifications"
 *   'none'  declares nothing
 * Neither declares a network host, another extension or a library.
 *
 * Plain JavaScript with no imports, so a frame can load it as it is.
 */

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A value's shape: its type, or for an object each key's type (sorted). */
function shape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key] === null ? 'null' : Array.isArray(value[key]) ? 'array' : typeof value[key]]));
}

/** Functions (and other members) a namespace has, sorted. */
const members = value => Object.keys(value || {}).sort();

/** What a call gave: its shape, or the error's name and whether it names what to declare. */
async function outcome(run) {
  try {
    return { ok: shape(await run()) };
  } catch (error) {
    return { error: error?.name || 'Error', saysWhatToDeclare: /declare it in extension\.json/.test(String(error?.message)) };
  }
}

/** A tiny silent WAV (a tenth of a second, 8 kHz mono). */
function silentWav() {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (at, value) => [...value].forEach((character, index) => view.setUint8(at + index, character.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples * 2, true);
  return new Blob([bytes], { type: 'audio/wav' });
}

/** A 1×1 PNG. */
function pixelPng() {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  return new Blob([Uint8Array.from(atob(base64), character => character.charCodeAt(0))], { type: 'image/png' });
}

export async function runContract(atmos, { declared }) {
  const all = declared === 'all';
  const report = { declared };

  // What the SDK has.
  report.sdkVersion = atmos.SDK_VERSION;
  report.api = members(atmos).filter(name => name !== 'fake');
  report.members = Object.fromEntries(['audio', 'wallpaper', 'location', 'state', 'events', 'lifecycle', 'notifications', 'appearance', 'contextMenu', 'clipboard', 'panel', 'commands']
    .map(name => [name, members(atmos[name])]));
  report.extension = members(atmos.extension);
  report.surface = members(atmos.surface).filter(name => typeof atmos.surface[name] !== 'function');

  // State and events: the extension's own, always allowed.
  await atmos.state.set({ a: 1 });
  await atmos.state.update({ b: 2 });
  report.state = await atmos.state.get();
  const heardEvents = [];
  const offEvent = atmos.events.on('contract-ping', payload => heardEvents.push(payload));
  await wait(150);
  await atmos.events.emit('contract-ping', { n: 1 });
  await wait(250);
  offEvent();
  report.ownEvent = heardEvents.length ? heardEvents[0] : null;
  report.emitWithPrefix = await outcome(() => atmos.events.emit('other:thing', {}));

  // Audio: the extension's own channel.
  const heardAudio = [];
  const offAudio = atmos.audio.onChange(value => heardAudio.push(value));
  await wait(250);
  report.audio = {
    load: await outcome(() => atmos.audio.load(silentWav(), { id: 'contract', loop: true })),
    loadUrl: await outcome(() => atmos.audio.load('https://example.com/a.wav')),
  };
  if (all) {
    await atmos.audio.load(silentWav(), { id: 'contract', loop: true });
    const loaded = await atmos.audio.state();
    report.audio.state = shape(loaded);
    report.audio.stateValues = { type: loaded.type, id: loaded.id, source: loaded.source, loop: loaded.loop };
    await wait(300);
    report.audio.heardLoad = heardAudio.some(value => value.type === 'source' && value.id === 'contract' && value.loop === true);
    report.audio.seekText = await outcome(() => atmos.audio.seek('later'));
    await atmos.audio.stop();
    const stopped = await atmos.audio.state();
    report.audio.afterStop = { id: stopped.id, source: stopped.source, loop: stopped.loop, playing: stopped.playing };
  } else {
    report.audio.state = await outcome(() => atmos.audio.state());
    report.audio.play = await outcome(() => atmos.audio.play());
    report.audio.stop = await outcome(() => atmos.audio.stop());
  }
  offAudio();

  // Wallpaper: set, then put back what it replaced.
  // (The thumbnail is null while there is no image, as in the fake.)
  const wallpaperGet = await outcome(() => atmos.wallpaper.get());
  if (wallpaperGet.ok?.thumbnail) wallpaperGet.ok.thumbnail = 'string or null';
  report.wallpaper = { get: wallpaperGet };
  if (all) {
    report.wallpaper.setText = await outcome(() => atmos.wallpaper.set(new Blob(['<p>no</p>'], { type: 'text/html' })));
    await atmos.wallpaper.set(pixelPng());
    report.wallpaper.afterSet = (await atmos.wallpaper.get())?.canRestore;
    report.wallpaper.restore = await atmos.wallpaper.restore();
    report.wallpaper.afterRestore = (await atmos.wallpaper.get())?.canRestore;
    report.wallpaper.restoreAgain = await atmos.wallpaper.restore();
  } else {
    report.wallpaper.set = await outcome(() => atmos.wallpaper.set(pixelPng()));
    report.wallpaper.restore = await outcome(() => atmos.wallpaper.restore());
  }

  // Location: read-only; null until the user sets one.
  report.location = await outcome(() => atmos.location.get());

  // Notifications: whether one was shown depends on the system, not the SDK.
  report.notifications = await outcome(() => atmos.notifications.show({ title: 'Contract', silent: true }));

  // What it didn't declare: a host, another extension, a library.
  report.fetchUndeclared = await outcome(() => atmos.fetch('https://undeclared.example/'));
  report.fetchHttp = await outcome(() => atmos.fetch('http://undeclared.example/'));
  report.invokeUndeclared = await outcome(() => atmos.invoke('service:somebody', 'thing'));
  report.callUndeclared = await outcome(() => atmos.call('service:somebody', 'thing'));
  report.libraryUndeclared = await outcome(() => atmos.library('service:somebody', 'index.js'));
  // First-party (SDK 1.2): web pages are for official extensions declaring "web".
  report.webRefused = await outcome(() => atmos.web.open('contract', { url: 'https://example.com/' }));

  return report;
}
