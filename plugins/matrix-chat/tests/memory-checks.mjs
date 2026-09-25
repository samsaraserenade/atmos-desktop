import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/bounded-cache.js', import.meta.url), 'utf8');
const { BoundedCache } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const tick = () => new Promise(resolve => setImmediate(resolve));
const cache = new BoundedCache({ maxBytes: 10, maxEntries: 2 });
cache.set('a', Promise.resolve(new ArrayBuffer(4)));
cache.set('b', Promise.resolve(new ArrayBuffer(4)));
await tick();
cache.get('a');
cache.set('c', Promise.resolve(new ArrayBuffer(4)));
await tick();
assert.equal(cache.has('b'), false, 'least recently used entry evicted');
assert.equal(cache.bytes, 8);
cache.set('oversized', Promise.resolve(new ArrayBuffer(20)));
await tick();
assert.equal(cache.has('oversized'), false, 'oversized results are not retained');
assert.ok(cache.bytes <= 10);
let resolveOld;
cache.set('late', new Promise(resolve => { resolveOld = resolve; }));
cache.clear();
cache.set('late', Promise.resolve(new ArrayBuffer(3)));
resolveOld(new ArrayBuffer(9));
await tick();
assert.equal(cache.bytes, 3, 'old completion cannot repopulate a cleared cache');
cache.set('failed', Promise.reject(new Error('network')));
await tick();
assert.equal(cache.has('failed'), false);
const ttl = new BoundedCache({ ttl: 10 });
ttl.set('expired', Promise.resolve({}));
ttl.entries.get('expired').time -= 11;
assert.equal(ttl.has('expired'), false);

// Exercise media lifecycle with controlled observers/downloads and fake DOM nodes.
const renderSource = readFileSync(new URL('../src/ui/message-render.js', import.meta.url), 'utf8');

// A slow avatar lookup for an old read-receipt position must not repaint that
// icon after a newer receipt update has already cleared the row.
const receiptStart = renderSource.indexOf('const receiptHydrationVersions =');
const receiptEnd = renderSource.indexOf('export async function hydrateReceipts(container', receiptStart);
let receiptRows = [{ userId: '@reader:test', ts: 1 }];
let resolveReceiptAvatar;
const hydrateReceiptNode = new Function('getReadReceipts', 'getAvatarUrl', 'escapeHtml',
  renderSource.slice(receiptStart, receiptEnd) + '; return hydrateReceiptsNode;')(
  () => receiptRows,
  () => new Promise(resolve => { resolveReceiptAvatar = resolve; }),
  value => value);
const receiptNode = { dataset: { receiptsFor: '$old' }, childNodes: [{}], innerHTML: '', isConnected: true };
const staleReceiptHydration = hydrateReceiptNode(receiptNode, {});
receiptRows = [];
await hydrateReceiptNode(receiptNode, {});
resolveReceiptAvatar('avatar-url');
await staleReceiptHydration;
assert.equal(receiptNode.innerHTML, '', 'stale receipt hydration cannot repaint a moved receipt');

const start = renderSource.indexOf('const mediaJobs =');
const end = renderSource.indexOf('// Fills in src for every inline', start);
const observers = [];
let downloads = 0;
let finish;
globalThis.IntersectionObserver = class {
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe() {}
  disconnect() {}
};
const hydrate = new Function('fetchMediaBytes', 'decryptAttachmentFile', 'isAtBottom', 'scrollToSuppressed',
  renderSource.slice(start, end).replace('export function', 'function') + '; return hydrateMedia;')(
  () => { downloads++; return new Promise(resolve => { finish = resolve; }); },
  () => { throw new Error('unexpected decrypt'); }, () => false, () => {});
function node(tagName) {
  return { tagName, dataset: { eventId: '1' }, isConnected: true, style: {}, listeners: {},
    setAttribute() {}, addEventListener(name, fn) { this.listeners[name] = fn; },
    removeEventListener() {}, load() {}, play() { return Promise.resolve(); } };
}
const room = { findEventById: () => ({ getContent: () => ({ url: 'mxc://test/media' }) }) };
const img = node('IMG');
hydrate({ querySelectorAll: () => [img] }, {}, room);
assert.equal(downloads, 0, 'offscreen images do not fetch');
observers.at(-1).callback([{ isIntersecting: true }]);
assert.equal(downloads, 1);
img.isConnected = false;
finish(new ArrayBuffer(1));
await tick();
assert.equal(img.src, undefined, 'detached images discard late downloads');
const video = node('VIDEO');
hydrate({ querySelectorAll: () => [video] }, {}, room);
observers.at(-1).callback([{ isIntersecting: true }]);
assert.equal(downloads, 1, 'visible videos do not download before interaction');
video.listeners.click({ type: 'click', preventDefault() {} });
assert.equal(downloads, 2, 'video interaction starts download');
video.isConnected = false;
finish(new ArrayBuffer(1));
await tick();
console.log('Memory checks passed: byte/entry LRU, oversized bypass, TTL, failures, session races, visibility, video deferral, detached rows.');

async function localModule(name) {
  const code = readFileSync(new URL(name, import.meta.url), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const { WorkQueue } = await localModule('../src/work-queue.js');
const queue = new WorkQueue(2);
const gates = [];
let started = 0;
const jobs = Array.from({ length: 6 }, () => queue.run(async () => {
  started++;
  await new Promise(resolve => gates.push(resolve));
}));
await tick();
assert.equal(started, 2, 'queue starts only two jobs');
gates.shift()();
await tick();
assert.equal(started, 3, 'completion frees one slot');
const abort = new AbortController();
let cancelledStarted = false;
const cancelled = queue.run(() => { cancelledStarted = true; }, { signal: abort.signal });
const cancelledCheck = assert.rejects(cancelled);
abort.abort();
await cancelledCheck;
while (started < 6 || queue.active) {
  gates.splice(0).forEach(resolve => resolve());
  await tick();
}
await Promise.all(jobs);
assert.equal(cancelledStarted, false, 'cancelled queued work never starts');
await assert.rejects(queue.run(() => { throw new Error('failure'); }));
assert.equal(await queue.run(() => 7), 7, 'failed work does not stall the queue');

const { MediaUrlCache } = await localModule('../src/media-url-cache.js');
const originalRevoke = URL.revokeObjectURL;
const revoked = new Set();
URL.revokeObjectURL = url => { revoked.add(url); originalRevoke(url); };
const urls = new MediaUrlCache({ maxBytes: 10, maxEntries: 3 });
const selected = await urls.acquire('selected', () => new Blob(['12345678']));
const idle = await urls.acquire('idle', () => new Blob(['12345678']));
idle.release();
assert.ok(revoked.has(idle.url), 'byte eviction revokes idle URLs');
assert.ok(!revoked.has(selected.url), 'displayed URL survives eviction');
selected.release();
const oversized = await urls.acquire('large', () => new Blob(['x'.repeat(20)]));
assert.ok(!revoked.has(oversized.url));
oversized.release();
assert.ok(revoked.has(oversized.url), 'oversized image is released after use');
assert.ok(urls.bytes <= 10);
let loads = 0;
const shared = await Promise.all([1, 2].map(() => urls.acquire('shared', () => {
  loads++;
  return new Blob(['abc']);
})));
assert.equal(loads, 1, 'shared URL requests deduplicate');
urls.clear();
shared[0].release();
assert.ok(!revoked.has(shared[1].url), 'one consumer cannot revoke another consumer’s URL');
shared[1].release();
assert.ok(revoked.has(shared[1].url));
let finishUrl;
const lateUrl = urls.acquire('pending', () => new Promise(resolve => { finishUrl = resolve; }));
await tick();
urls.clear();
finishUrl(new Blob(['late']));
await assert.rejects(lateUrl, /cleared/);
assert.equal(urls.bytes, 0, 'cleared pending loads cannot repopulate URL cache');

const { relationsForEvent, invalidateRoomRelations, clearRelationIndexes } = await localModule('../src/relation-index.js');
let contentReads = 0;
function event(id, type, target, relationType, sender = 'alice') {
  return { id, type, target, relationType, sender, redacted: false,
    getId() { return this.id; }, getType() { return this.type; },
    getSender() { return this.sender; }, getTs() { return 1; },
    isRedacted() { return this.redacted; },
    getContent() { contentReads++; return { 'm.relates_to': { event_id: this.target, rel_type: this.relationType, key: '👍' } }; } };
}
const reaction = event('r', 'm.reaction', 'message', 'm.annotation');
const edit = event('e', 'm.room.message', 'message', 'm.replace');
const encryptedEvent = event('enc', 'm.room.encrypted', 'message', 'm.replace');
let relationEvents = [reaction, edit, encryptedEvent];
let timeline = { getEvents: () => relationEvents };
const relationRoom = { getLiveTimeline: () => timeline };
assert.deepEqual(relationsForEvent(relationRoom, 'message', 'm.annotation'), [reaction]);
const reads = contentReads;
for (let i = 0; i < 100; i++) relationsForEvent(relationRoom, 'message', 'm.replace');
assert.equal(contentReads, reads, 'repeated row lookups do not rescan the timeline');
encryptedEvent.type = 'm.room.message';
invalidateRoomRelations(relationRoom);
assert.deepEqual(relationsForEvent(relationRoom, 'message', 'm.replace'), [edit, encryptedEvent]);
reaction.redacted = true;
invalidateRoomRelations(relationRoom);
assert.equal(relationsForEvent(relationRoom, 'message', 'm.annotation').length, 0);
const backfill = event('old', 'm.reaction', 'earlier', 'm.annotation');
relationEvents.unshift(backfill);
assert.deepEqual(relationsForEvent(relationRoom, 'earlier', 'm.annotation'), [backfill]);
timeline = { getEvents: () => [] };
assert.equal(relationsForEvent(relationRoom, 'message', 'm.replace').length, 0, 'timeline reset releases old relations');
clearRelationIndexes();

// Use the viewer's callback contract to verify lazy loading and stale navigation.
const fullscreenSource = readFileSync(new URL('../src/ui/fullscreen-media.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^const \{ createFullscreenViewer \} = await import\(.*\);\r?\n/m, '')
  .replace('export function', 'function');
let viewerOptions;
let viewerItems;
let currentImage;
const slot = { addEventListener() {}, querySelector: () => currentImage };
globalThis.document = {
  body: { appendChild() {} }, addEventListener() {}, removeEventListener() {},
  createElement: () => ({ addEventListener() {}, remove() {}, querySelector: () => slot }),
};
const fullDownloads = [];
const makeFullscreen = new Function('fetchMediaBytes', 'decryptAttachmentFile', 'MediaUrlCache', 'createFullscreenViewer',
  fullscreenSource + '; return createFullscreenMedia;')(
  url => new Promise(resolve => fullDownloads.push({ url, resolve })),
  () => { throw new Error('unexpected decrypt'); }, MediaUrlCache,
  (_slot, options) => {
    viewerOptions = options;
    return { open(items, id) {
      viewerItems = items;
      const selected = items.find(item => item.id === id);
      currentImage = selected?.kind === 'video'
        ? { load() {}, play: () => Promise.resolve() }
        : {};
      options.onOpen(selected);
    },
      close() {}, destroy() {} };
  });
const gallery = Array.from({ length: 30 }, (_, i) => ({
  dataset: { eventId: String(i) }, tagName: 'IMG', src: `preview-${i}`,
}));
const fs = makeFullscreen({
  room: { findEventById: id => ({ getId: () => id, getContent: () => ({ url: `full-${id}`, info: {} }) }) },
  collectMediaNodes: () => gallery, onImageContextMenu() {},
});
fs.open('0');
await tick();
assert.equal(fullDownloads.length, 1, 'opening a large gallery fetches only the selected image');
assert.equal(viewerItems.length, 30, 'all gallery items remain navigable');
currentImage = {};
viewerOptions.onNavigate(viewerItems[1]);
await tick();
fullDownloads[0].resolve(new ArrayBuffer(1));
await tick();
assert.equal(currentImage.src, undefined, 'late download cannot overwrite the newly selected image');
fullDownloads[1].resolve(new ArrayBuffer(1));
await tick();
assert.ok(currentImage.src.startsWith('blob:'));
assert.equal(viewerItems[1].url, 'preview-1', 'gallery never retains unleased full-resolution URLs');
fs.clearCache();

// Videos may enter fullscreen before their lazy inline player has a src.
// The fullscreen path must resolve the original attachment and hand it to
// the viewer's video element rather than relying on an inline preview URL.
const videoFs = makeFullscreen({
  room: { findEventById: id => ({ getId: () => id, getContent: () => ({ url: `video-${id}`, info: {} }) }) },
  collectMediaNodes: () => [{ dataset: { eventId: 'video' }, tagName: 'VIDEO', src: '' }],
  onImageContextMenu() {},
});
videoFs.open('video');
await tick();
fullDownloads.at(-1).resolve(new ArrayBuffer(1));
await tick();
assert.ok(currentImage.src.startsWith('blob:'), 'fullscreen video loads without an inline src');
videoFs.clearCache();

const beforeSmallGallery = fullDownloads.length;
const smallFs = makeFullscreen({
  room: { findEventById: id => ({ getId: () => id, getContent: () => ({ url: `small-${id}`, info: { size: 1024 } }) }) },
  collectMediaNodes: () => gallery, onImageContextMenu() {},
});
smallFs.open('10');
await tick();
assert.equal(fullDownloads.length - beforeSmallGallery, 1);
fullDownloads.at(-1).resolve(new ArrayBuffer(1));
await tick();
assert.equal(fullDownloads.at(-1).url, 'small-11', 'next small image is prefetched');
fullDownloads.at(-1).resolve(new ArrayBuffer(1));
await tick();
assert.equal(fullDownloads.at(-1).url, 'small-9', 'previous small image is prefetched');
fullDownloads.at(-1).resolve(new ArrayBuffer(1));
await tick();
assert.equal(fullDownloads.length - beforeSmallGallery, 3, 'preloading stops after two neighbours');
currentImage = {};
viewerOptions.onNavigate(viewerItems[20]);
await tick();
smallFs.clearCache();
fullDownloads.at(-1).resolve(new ArrayBuffer(1));
await tick();
assert.equal(currentImage.src, undefined, 'closing during a download prevents a late viewer update');
URL.revokeObjectURL = originalRevoke;
console.log('Additional checks passed: queue limits/cancellation, URL byte budgets/leases, relation indexing/invalidation, fullscreen lazy navigation.');
