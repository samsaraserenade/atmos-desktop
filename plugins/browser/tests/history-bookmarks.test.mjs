// History and bookmarks, and how they are stored (src/history.js, src/bookmarks.js, src/store.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, bareUrl } from '../src/history.js';
import { createBookmarks } from '../src/bookmarks.js';
import { memoryTable } from '../src/store.js';

const DAY = 24 * 60 * 60 * 1000;

function clock(start = 10 * DAY) {
  let t = start;
  return { now: () => t, tick: ms => { t += ms; } };
}

test('a visit is recorded once per address, counted, and kept in the table', async () => {
  const table = memoryTable('url');
  const time = clock();
  const history = createHistory(table, { now: time.now });
  await history.visit('https://example.com/', 'Example');
  time.tick(1000);
  await history.visit('https://example.com/', '');
  const [entry] = await history.search('');
  assert.equal(entry.visits, 2);
  assert.equal(entry.title, 'Example', 'an empty title keeps the one it had');
  assert.equal(entry.lastVisit - entry.firstVisit, 1000);
  assert.equal(table.size, 1);
  // Read back by a fresh instance (the next start).
  const again = createHistory(table, { now: time.now });
  assert.equal((await again.search('example'))[0].visits, 2);
});

test('only web pages are kept, and titles arrive later', async () => {
  const history = createHistory(memoryTable('url'), clock());
  for (const url of ['about:blank', 'file:///etc/passwd', 'mailto:a@b.c', '', null, `https://x.example/${'a'.repeat(9000)}`]) {
    assert.equal(await history.visit(url, 'x'), null, String(url).slice(0, 30));
  }
  await history.visit('https://news.example/today', '');
  await history.setTitle('https://news.example/today', 'Today’s news');
  assert.equal((await history.search('today'))[0].title, 'Today’s news');
  await history.setTitle('https://unknown.example/', 'Nothing');
  assert.equal(history.size, 1);
});

test('searching matches every word in the title or address, newest first', async () => {
  const time = clock();
  const history = createHistory(memoryTable('url'), { now: time.now });
  await history.visit('https://www.recipes.example/soup/tomato', 'Tomato soup');
  time.tick(10);
  await history.visit('https://www.recipes.example/soup/onion', 'French onion soup');
  time.tick(10);
  await history.visit('https://weather.example/', 'Weather');
  assert.deepEqual((await history.search('soup')).map(entry => entry.title), ['French onion soup', 'Tomato soup']);
  assert.deepEqual((await history.search('SOUP tomato')).map(entry => entry.title), ['Tomato soup']);
  assert.deepEqual((await history.search('recipes.example/soup/on')).map(entry => entry.title), ['French onion soup']);
  assert.equal((await history.search('www')).length, 0, 'the scheme and "www." aren\'t matched');
  assert.equal((await history.search('')).length, 3);
  assert.equal((await history.search('', { limit: 1 }))[0].title, 'Weather');
});

test('address-bar suggestions put addresses that start with what you typed first', async () => {
  const time = clock();
  const history = createHistory(memoryTable('url'), { now: time.now });
  await history.visit('https://github.com/atmos', 'Atmos on GitHub');
  await history.visit('https://docs.example/git-guide', 'A guide to git');
  for (let i = 0; i < 5; i++) await history.visit('https://blog.example/why-git', 'Why git?');
  const titles = (await history.suggest('git')).map(entry => entry.title);
  assert.equal(titles[0], 'Atmos on GitHub', 'the address starts with it');
  assert.ok(titles.includes('A guide to git') && titles.includes('Why git?'));
  assert.deepEqual(await history.suggest('   '), []);
  assert.equal(bareUrl('https://www.example.com/x'), 'example.com/x');
});

test('top sites: one address per site, the most visited sites first', async () => {
  const time = clock();
  const history = createHistory(memoryTable('url'), { now: time.now });
  for (let i = 0; i < 3; i++) await history.visit('https://a.example/1', 'A1');
  await history.visit('https://a.example/2', 'A2');
  await history.visit('https://b.example/', 'B');
  const top = await history.topSites(5);
  assert.deepEqual(top.map(entry => entry.url), ['https://a.example/1', 'https://b.example/']);
});

test('clearing all history, the last hour, or one entry; old entries are pruned', async () => {
  const table = memoryTable('url');
  const time = clock(200 * DAY);
  const history = createHistory(table, { now: time.now, maxEntries: 3, maxAgeDays: 90 });
  await history.visit('https://old.example/', 'Old');
  time.tick(100 * DAY);
  await history.visit('https://a.example/', 'A');
  time.tick(DAY);
  await history.visit('https://b.example/', 'B');
  await history.visit('https://c.example/', 'C');
  assert.equal(await history.prune(), 1, 'more than 90 days old');
  assert.equal(table.size, 3);
  await history.clear({ since: time.now() - 1000 });
  assert.deepEqual((await history.search('')).map(entry => entry.title), ['A'], 'only the last moment went');
  assert.equal(await history.remove('https://a.example/'), true);
  assert.equal(await history.remove('https://a.example/'), false);
  await history.visit('https://d.example/', 'D');
  let heard = 0;
  history.subscribe(() => heard++);
  await history.clear();
  assert.equal(table.size, 0);
  assert.equal(heard, 1);
});

test('bookmarks: add once per address, rename, move, remove, toggle, kept in order', async () => {
  const table = memoryTable('id');
  const time = clock();
  const bookmarks = createBookmarks(table, { now: time.now });
  const a = await bookmarks.add({ url: 'https://a.example/', title: 'A' });
  const b = await bookmarks.add({ url: 'https://b.example/', title: '' });
  assert.equal(b.title, 'https://b.example/', 'no title: its address');
  assert.equal((await bookmarks.add({ url: 'https://a.example/', title: 'Again' })).id, a.id);
  await assert.rejects(bookmarks.add({ url: 'javascript:alert(1)' }), /Only web pages/);
  await assert.rejects(bookmarks.add({ url: 'file:///x' }), /Only web pages/);
  assert.equal(await bookmarks.rename(b.id, '  Bee  '), true);
  assert.equal(await bookmarks.rename(b.id, '   '), false);
  const c = await bookmarks.add({ url: 'https://c.example/', title: 'C' });
  await bookmarks.move(c.id, 0);
  assert.deepEqual((await bookmarks.list()).map(item => item.title), ['C', 'A', 'Bee']);
  assert.ok(bookmarks.has('https://a.example/'));
  assert.equal(await bookmarks.toggle('https://a.example/', 'A'), false);
  assert.equal(bookmarks.has('https://a.example/'), false);
  assert.equal(await bookmarks.toggle('https://a.example/', 'A'), true);
  // The next start reads them back in order.
  const again = createBookmarks(table, { now: time.now });
  assert.deepEqual((await again.list()).map(item => item.title), ['C', 'Bee', 'A']);
  assert.equal(await again.remove(c.id), true);
  assert.equal(await again.remove(c.id), false);
  assert.equal((await again.find('https://b.example/')).title, 'Bee');
});
