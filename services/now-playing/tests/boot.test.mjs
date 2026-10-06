// Now Playing's background frame (boot.js): Space, rev/play (rev/pause),
// rev/next and rev/previous act on what the widget shows, whoever plays it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const fakeSdk = new URL('../../../core/js/sdk/testing/sdk.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'atmos-sdk') return { url: fakeSdk, shortCircuit: true };
  return nextResolve(specifier, context);
} });

const { installFakeAtmos } = await import('../../../core/js/sdk/testing/fake-atmos.mjs');
const manifest = JSON.parse(readFileSync(new URL('../extension.json', import.meta.url), 'utf8'));
const atmos = installFakeAtmos({ extension: { id: 'now-playing', kind: 'service', tier: 'first-party' }, commands: manifest.contributes.commands });
await import('../boot.js');

const run = name => atmos.fake.runCommand(name, {});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const music = { id: 'plugin:audio-player|main', title: 'One More Time', playing: false, playingSince: null, lastActive: 100, actions: ['toggle', 'next', 'previous'] };
const video = { id: 'plugin:browser|t1', title: 'A video', playing: true, playingSince: 200, lastActive: 200, actions: ['toggle'] };

test('declared for the bar: rev/play is also rev/pause; Space is its key', () => {
  assert.deepEqual(manifest.contributes.commands.map(command => [command.name, command.aliases || []]), [['play', ['pause']], ['next', []], ['previous', []]]);
  assert.deepEqual(manifest.contributes.boot, { entry: 'boot.js', keys: ['Space'] });
  assert.deepEqual(atmos.fake.commandsHandled.sort(), ['next', 'play', 'previous']);
});

test('nothing playing: they say so', async () => {
  atmos.fake.showNowPlaying([]);
  await assert.rejects(run('play'), /Nothing is playing in Atmos/);
});

test('rev/play and Space toggle what shows: the one started last', async () => {
  atmos.fake.nowPlayingControls.length = 0;
  atmos.fake.showNowPlaying([music, video]);
  assert.deepEqual(await run('play'), { done: 'Paused A video.' });
  atmos.fake.pressKey('Space');
  await settle();
  assert.deepEqual(atmos.fake.nowPlayingControls, [
    { id: video.id, action: 'toggle', value: null },
    { id: video.id, action: 'toggle', value: null },
  ]);
});

test('next and previous only where the session takes them', async () => {
  atmos.fake.showNowPlaying([music, video]);
  await assert.rejects(run('next'), /A video can’t skip to the next one/);
  atmos.fake.showNowPlaying([music]);
  atmos.fake.nowPlayingControls.length = 0;
  assert.deepEqual(await run('next'), { done: 'Next.' });
  assert.deepEqual(await run('play'), { done: 'Playing One More Time.' });
  assert.deepEqual(atmos.fake.nowPlayingControls.map(control => control.action), ['next', 'toggle']);
});

test('the one picked with the widget\'s dots is the one they act on', async () => {
  atmos.fake.showNowPlaying([music, video]);
  atmos.fake.emit('pick', { id: music.id, at: 300 });
  atmos.fake.nowPlayingControls.length = 0;
  assert.deepEqual(await run('next'), { done: 'Next.' });
  assert.equal(atmos.fake.nowPlayingControls[0].id, music.id);
});
