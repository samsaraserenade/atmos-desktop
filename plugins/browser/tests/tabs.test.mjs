// The tab list and which pages to put away (src/tabs.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabList, pagesToPutAway, newTabId } from '../src/tabs.js';

function clockList() {
  let t = 1000;
  let n = 0;
  const list = createTabList({ now: () => t, makeId: () => `t${++n}` });
  return { list, tick: (ms = 1) => { t += ms; }, at: () => t };
}
const ids = list => list.tabs.map(tab => tab.id);

test('tab ids are what Core accepts', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const id = newTabId();
    assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.ok(!seen.has(id));
    seen.add(id);
  }
});

test('adding, selecting and closing; there is always a tab', () => {
  const { list } = clockList();
  const a = list.add({ url: 'https://a.example/' });
  const b = list.add({ url: 'https://b.example/' });
  const c = list.add({ url: 'https://c.example/', select: false });
  assert.deepEqual(ids(list), [a.id, b.id, c.id]);
  assert.equal(list.selected, b.id, 'a tab opened behind is not selected');
  assert.equal(list.close(b.id).selected, c.id, 'closing selects the tab to the right');
  assert.equal(list.close(c.id).selected, a.id, '…or to the left at the end');
  const last = list.close(a.id);
  assert.equal(list.tabs.length, 1, 'closing the last tab leaves a new-tab page');
  assert.equal(list.tabs[0].url, '');
  assert.equal(last.selected, list.tabs[0].id);
  assert.equal(list.close('nope'), null);
});

test('tabs opened from a tab go after it, in order, and closing one goes back to its opener', () => {
  const { list } = clockList();
  const a = list.add({ url: 'https://a.example/' });
  const z = list.add({ url: 'https://z.example/' });
  list.select(a.id);
  const one = list.add({ url: 'https://1.example/', after: a.id, opener: a.id, select: false });
  const two = list.add({ url: 'https://2.example/', after: a.id, opener: a.id, select: false });
  assert.deepEqual(ids(list), [a.id, one.id, two.id, z.id]);
  list.select(two.id);
  assert.equal(list.close(two.id).selected, a.id, 'back to the tab it was opened from');
  list.close(a.id);
  assert.equal(list.get(one.id).opener, null, 'a closed opener is forgotten');
});

test('reopening closed tabs, most recent first, where they were', () => {
  const { list } = clockList();
  const a = list.add({ url: 'https://a.example/', title: 'A' });
  const b = list.add({ url: 'https://b.example/', title: 'B' });
  list.add({ url: 'https://c.example/' });
  list.close(a.id);
  list.close(b.id);
  assert.equal(list.closedCount, 2);
  const back = list.reopen();
  assert.equal(back.url, 'https://b.example/');
  assert.equal(back.title, 'B');
  assert.notEqual(back.id, b.id, 'a new id: Core may still be closing the old page');
  assert.equal(list.selected, back.id);
  assert.equal(list.reopen().url, 'https://a.example/');
  assert.equal(list.tabs[0].url, 'https://a.example/', 'at its old place');
  assert.equal(list.reopen(), null);
  // A new-tab page isn't worth reopening.
  const blank = list.add({});
  list.close(blank.id);
  assert.equal(list.closedCount, 0);
});

test('moving and cycling through tabs', () => {
  const { list } = clockList();
  const [a, b, c] = ['a', 'b', 'c'].map(name => list.add({ url: `https://${name}.example/` }));
  list.move(c.id, 0);
  assert.deepEqual(ids(list), [c.id, a.id, b.id]);
  list.move(c.id, 99);
  assert.deepEqual(ids(list), [a.id, b.id, c.id]);
  list.select(c.id);
  assert.equal(list.neighbour(1).id, a.id, 'round the end');
  assert.equal(list.neighbour(-1).id, b.id);
  assert.equal(list.move('nope', 0), false);
});

test('only ordinary tabs are kept across starts, and bad saved data is dropped', () => {
  const { list } = clockList();
  const a = list.add({ url: 'https://a.example/', title: 'A' });
  list.add({ url: 'https://secret.example/', private: true });
  const saved = list.serialize();
  assert.deepEqual(saved.tabs.map(tab => tab.url), ['https://a.example/']);
  assert.equal(saved.selected, a.id, 'a private tab selected: the last ordinary one is');

  const { list: again } = clockList();
  again.restore({
    tabs: [
      { id: a.id, url: 'https://a.example/', title: 'A' },
      { id: 'bad id!', url: 'https://x.example/' },
      { id: 'f1', url: 'file:///etc/passwd' },
      { id: 'j1', url: 'javascript:alert(1)' },
      { id: a.id, url: 'https://duplicate.example/' },
      { id: 'n1', url: '' },
      { id: 'p1', url: 'https://p.example/', private: true },
    ],
    selected: 'n1',
  });
  assert.deepEqual(again.tabs.map(tab => [tab.id, tab.url, tab.private]), [[a.id, 'https://a.example/', false], ['n1', '', false], ['p1', 'https://p.example/', false]]);
  assert.equal(again.selected, 'n1');
  const { list: empty } = clockList();
  empty.restore(null);
  assert.equal(empty.tabs.length, 1);
  assert.equal(empty.selected, empty.tabs[0].id);
});

test('closed private tabs are forgotten when their session ends', () => {
  const { list } = clockList();
  list.add({ url: 'https://a.example/' });
  const p = list.add({ url: 'https://p.example/', private: true });
  list.close(p.id);
  assert.equal(list.closedCount, 1);
  list.forgetPrivate();
  assert.equal(list.closedCount, 0);
});

test('pages put away: idle ones first, then the least recently used past the limit', () => {
  const tabs = [
    { id: 'a', lastActive: 0 }, { id: 'b', lastActive: 50 }, { id: 'c', lastActive: 90 },
    { id: 'd', lastActive: 95 }, { id: 'e', lastActive: 99 },
  ];
  const live = new Set(['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(pagesToPutAway(tabs, { live, now: 100, idleMs: 40, maxLive: 0 }).sort(), ['a', 'b']);
  assert.deepEqual(pagesToPutAway(tabs, { live, now: 100, idleMs: 0, maxLive: 3 }).sort(), ['a', 'b']);
  assert.deepEqual(pagesToPutAway(tabs, { live, now: 100, idleMs: 0, maxLive: 2 }).sort(), ['a', 'b', 'c']);
  assert.deepEqual(pagesToPutAway(tabs, { live, now: 100, idleMs: 0, maxLive: 2, keep: tab => tab.id === 'a' }).sort(), ['b', 'c', 'd'],
    'a kept page still counts toward the limit');
  assert.deepEqual(pagesToPutAway(tabs, { live: new Set(['e']), now: 1e9, idleMs: 1, maxLive: 1 }), ['e']);
  assert.deepEqual(pagesToPutAway(tabs, { live, now: 100, idleMs: 0, maxLive: 0 }), [], 'never and no limit');
});
