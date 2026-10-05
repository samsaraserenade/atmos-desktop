// Matrix Chat's rev/ commands (src/ui/command-handlers.js) as Atmos's bar
// uses them: what each lists for what's typed, and what running one does,
// against the SDK's fake Atmos and a stand-in engine (fake-command-engine.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const fakeSdk = new URL('../../../core/js/sdk/testing/sdk.mjs', import.meta.url).href;
const fakeEngine = new URL('./fake-command-engine.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'atmos-sdk') return { url: fakeSdk, shortCircuit: true };
  if (specifier === './engine.js' && context.parentURL?.endsWith('/src/ui/command-handlers.js')) return { url: fakeEngine, shortCircuit: true };
  return nextResolve(specifier, context);
} });

const { installFakeAtmos } = await import('../../../core/js/sdk/testing/fake-atmos.mjs');
const { world, reset } = await import('./fake-command-engine.mjs');
const manifest = JSON.parse(readFileSync(new URL('../extension.json', import.meta.url), 'utf8'));
const atmos = installFakeAtmos({ extension: { id: 'matrix-chat', tier: 'first-party' }, commands: manifest.contributes.commands });
const { handleCommands } = await import('../src/ui/command-handlers.js');
handleCommands();

const suggest = (name, input = {}) => atmos.fake.suggestCommand(name, input);
const run = (name, input = {}) => atmos.fake.runCommand(name, input);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = name => world.calls.filter(([called]) => called === name).map(([, ...args]) => args);
const open = roomId => { world.view = { type: 'room', roomId }; };

test('every command extension.json declares is handled here, and nothing else', () => {
  assert.deepEqual(atmos.fake.commandsHandled.sort(), manifest.contributes.commands.map(command => command.name).sort());
});

test('rev/go lists your rooms and chats by name and opens one in the Chat panel', async () => {
  reset();
  assert.deepEqual((await suggest('go')).map(row => [row.title, row.sub, row.value, row.complete]), [
    ['General', 'Atmos', '!general:example.org', 'General'],
    ['Random', 'Room', '!random:example.org', 'Random'],
    ['Rin', 'Direct message', '!dm-rin:example.org', 'Rin'],
  ], 'spaces and rooms you left aren\'t listed; a chat is named after the other person');
  assert.deepEqual((await suggest('go', { args: 'RI' })).map(row => row.title), ['Rin']);
  assert.deepEqual(await suggest('go', { args: 'nothing like it' }), [{ note: 'None of your rooms or chats match.' }]);

  const shown = atmos.fake.panelShown;
  assert.equal(await run('go', { args: 'ri', value: '!dm-rin:example.org' }), undefined, 'the bar closes');
  assert.deepEqual(world.view, { type: 'room', roomId: '!dm-rin:example.org' });
  assert.equal(atmos.fake.panelShown, shown + 1, 'the Chat panel comes forward');
  await run('go', { args: 'gen' });
  assert.equal(world.view.roomId, '!general:example.org', 'Enter before the list caught up: the first that matches');
  await assert.rejects(run('go', { args: 'nothing like it' }), /None of your rooms or chats match/);
});

test('rev/join: rooms in your spaces, public rooms once three letters are typed, or an address', async () => {
  reset();
  assert.deepEqual(await suggest('join'), [{ note: 'Looking in your spaces…' }]);
  const refreshes = atmos.fake.commandRefreshes;
  await wait(0);
  assert.equal(atmos.fake.commandRefreshes, refreshes + 1, 'the bar asks again once the space\'s rooms are in');
  assert.deepEqual(await suggest('join'), [
    { heading: 'In your spaces' },
    { title: 'Lobby', sub: 'in Atmos · 3 members', action: 'Join', value: 'child:!lobby:example.org', complete: 'Lobby' },
  ], 'not the rooms you\'re in, nor invite-only ones');
  assert.deepEqual(calls('getSpaceChildren'), [['!space:example.org']], 'fetched once, then kept a while');

  assert.deepEqual(await suggest('join', { args: 'matrix' }), [{ note: 'Searching public rooms…' }]);
  assert.deepEqual(await suggest('join', { args: 'matrix' }), [{ note: 'Searching public rooms…' }], 'one search per text');
  await wait(350);
  assert.deepEqual(calls('browsePublicRooms'), [[{ search: 'matrix', limit: 8 }]]);
  assert.deepEqual(await suggest('join', { args: 'matrix' }), [
    { heading: 'Public rooms' },
    { title: 'Matrix HQ', sub: '42 members · #matrix:matrix.org · The Matrix', action: 'Join', value: 'public:!hq:matrix.org', complete: '#matrix:matrix.org' },
  ]);

  await run('join', { args: '', value: 'child:!lobby:example.org' });
  assert.deepEqual(calls('joinSpaceRoom'), [['!lobby:example.org', ['example.org']]]);
  assert.equal(world.view.roomId, '!lobby:example.org');
  await run('join', { args: 'matrix', value: 'public:!hq:matrix.org' });
  assert.deepEqual(calls('joinPublicRoom'), [['#matrix:matrix.org']], 'by its address');
  assert.deepEqual(await suggest('join', { args: '#atmos:example.org' }), [{ title: 'Join #atmos:example.org', action: 'Join', value: 'address' }]);
  await run('join', { args: '#atmos:example.org', value: 'address' });
  assert.deepEqual(calls('joinByAddress'), [['#atmos:example.org']]);
  assert.equal(world.view.roomId, '!joined:example.org');
  await assert.rejects(run('join', { args: 'lob' }), /Choose a room to join/);
});

test('rev/dm: someone by Matrix ID, or one of your chats', async () => {
  reset();
  assert.deepEqual(await suggest('dm', { args: '@rin:example.org' }), [
    { title: 'Message @rin:example.org', sub: 'Starts a private, encrypted chat, or opens the one you have', action: 'Message', value: 'new' },
    { heading: 'Your chats' },
    { title: 'Rin', sub: 'Direct message', action: 'Open', value: '!dm-rin:example.org', complete: 'Rin' },
  ]);
  assert.deepEqual(await suggest('dm', { args: '@nobody' }), [{ note: 'Type their full Matrix ID, such as @name:matrix.org.' }]);
  await run('dm', { args: '@kai:example.org', value: 'new' });
  assert.deepEqual(calls('addFriend'), [['@kai:example.org']]);
  assert.equal(world.view.roomId, '!dm-new:example.org');
  await run('dm', { args: 'ri' });
  assert.equal(world.view.roomId, '!dm-rin:example.org');
});

test('rev/create-room: its options, as they\'d be unless chosen, and what\'s created', async () => {
  reset();
  assert.deepEqual(await suggest('create-room'), [{ note: 'Type a name for the new room.' }]);
  open('!general:example.org');
  const fresh = await suggest('create-room', { args: 'Plugin Showcase' });
  assert.deepEqual(fresh.rows, [{ title: 'Create room “Plugin Showcase”', sub: 'in Atmos · anyone in the space · encrypted', action: 'Create' }],
    'in the open room\'s space, for anyone in it, encrypted');
  assert.deepEqual(fresh.options.map(option => [option.id, option.type, option.value]), [
    ['parent', 'select', '!space:example.org'], ['access', 'select', 'space'], ['encrypted', 'toggle', true],
  ]);
  assert.deepEqual(fresh.options[0].options, [{ value: '', label: 'no space' }, { value: '!space:example.org', label: 'Atmos' }]);
  assert.deepEqual(fresh.options[1].options.map(choice => choice.label), ['invite only', 'anyone in the space', 'public']);
  assert.equal(fresh.options[1].style, 'chips');

  const outside = await suggest('create-room', { args: 'Plugin Showcase', options: { parent: '' } });
  assert.equal(outside.rows[0].sub, 'invite only · encrypted');
  assert.deepEqual(outside.options[1].options.map(choice => choice.value), ['private', 'public'], 'no space, no "anyone in the space"');

  const publicOne = await suggest('create-room', { args: 'Plugin Showcase', options: { access: 'public' } });
  assert.deepEqual(publicOne.options.map(option => [option.id, option.value]), [
    ['parent', '!space:example.org'], ['access', 'public'], ['encrypted', false], ['alias', 'plugin-showcase'], ['listed', false],
  ], 'public: not encrypted unless chosen, and an address from its name');
  assert.deepEqual([publicOne.options[3].prefix, publicOne.options[3].suffix], ['#', ':example.org']);

  await run('create-room', { args: 'Plugin Showcase', options: { access: 'public', alias: '#showcase:elsewhere', listed: true } });
  assert.deepEqual(calls('createRoom'), [[{
    name: 'Plugin Showcase', access: 'public', alias: 'showcase', listed: true, parentSpaceId: '!space:example.org', encrypted: false,
  }]]);
  assert.equal(world.view.roomId, '!new-room:example.org');
  await assert.rejects(run('create-room', { args: '' }), /Type a name/);
});

test('rev/create-space goes on to its first room, in it, once sync has it', async () => {
  reset();
  const result = await run('create-space', { args: 'Guild' });
  assert.deepEqual(calls('createSpace'), [[{ name: 'Guild', access: 'private', alias: 'guild', listed: false, parentSpaceId: null }]]);
  assert.deepEqual(result, { fill: 'rev/create-room ', options: { parent: '!new-space:example.org' }, done: 'Created Guild. Name its first room, or press Esc.' });
  assert.ok(world.rooms.some(item => item.roomId === '!new-space:example.org'), 'waited for sync');
  const next = await suggest('create-room', { args: 'Lounge', options: result.options });
  assert.equal(next.rows[0].sub, 'in Guild · anyone in the space · encrypted');
  assert.deepEqual(await suggest('create-space', { args: 'Guild' }).then(answer => answer.options.map(option => option.id)), ['parent', 'access'],
    'a space has no encryption of its own');
});

test('rev/invite and rev/leave are about the open room; leaving is marked as such', async () => {
  reset();
  assert.deepEqual(await suggest('invite', { args: '@rin:example.org' }), [{ note: 'Open a room to invite someone to it.' }]);
  await assert.rejects(run('leave'), /Open a room to leave it/);
  open('!general:example.org');
  assert.deepEqual(await suggest('invite', { args: '@rin' }), [{ note: 'Type their full Matrix ID, such as @name:matrix.org.' }]);
  assert.deepEqual(await suggest('invite', { args: '@rin:example.org' }), [{ title: 'Invite @rin:example.org', sub: 'to General', action: 'Invite', value: '!general:example.org' }]);
  assert.deepEqual(await run('invite', { args: '@rin:example.org', value: '!general:example.org' }), { done: 'Invited @rin:example.org.' });
  assert.deepEqual(calls('inviteToRoom'), [['!general:example.org', '@rin:example.org']]);
  const leaveRows = await suggest('leave');
  assert.deepEqual(leaveRows, [{ title: 'Leave General', sub: 'You can rejoin later if the room lets you', action: 'Leave', value: '!general:example.org', danger: true }]);
  // Another room opened between listing and running: it's the one the row named that's left.
  open('!random:example.org');
  assert.deepEqual(await run('leave', { value: leaveRows[0].value }), { done: 'Left General.' });
  assert.deepEqual(calls('leaveRoom'), [['!general:example.org']]);
  await assert.rejects(run('leave', { value: '!old:example.org' }), /not in that room any more/);
});

test('rev/notifications offers the other state, or the one typed', async () => {
  reset();
  assert.deepEqual(await suggest('notifications'), [{ title: 'Ping sound off', sub: 'Stay quiet when messages arrive', action: 'Turn off' }]);
  assert.deepEqual(await suggest('notifications', { args: 'ON' }), [{ title: 'Ping sound on', sub: 'It’s already on', action: 'Turn on' }]);
  assert.deepEqual(await run('notifications'), { done: 'Ping sound off.' });
  assert.equal(world.sound, false);
});

test('signed out, each says to sign in first', async () => {
  reset();
  world.session = false;
  for (const name of ['go', 'join', 'dm', 'create-room', 'create-space', 'invite', 'leave']) {
    const answer = await suggest(name, { args: 'x' });
    assert.deepEqual(Array.isArray(answer) ? answer : answer.rows, [{ note: 'Sign in to Matrix Chat first.' }], name);
    await assert.rejects(run(name, { args: 'x', value: 'x' }), /Sign in to Matrix Chat first/, name);
  }
});
