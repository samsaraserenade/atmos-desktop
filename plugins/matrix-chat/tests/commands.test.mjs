import test from 'node:test';
import assert from 'node:assert/strict';
import { isCommand, parseCommand, matchCommands, isMatrixId, isRoomAddress, slugOf } from '../src/ui/commands.js';

test('only messages starting with rev/ are commands', () => {
  assert.equal(isCommand('rev/room x'), true);
  assert.equal(isCommand('  REV/join'), true);
  assert.equal(isCommand('@rin hello'), false);
  assert.equal(isCommand('see rev/room'), false);
});

test('parses the command name and its arguments', () => {
  assert.deepEqual({ ...parseCommand('rev/ro'), command: undefined }, { name: 'ro', args: '', typingName: true, command: undefined });
  const room = parseCommand('rev/create-room  Plugin Showcase ');
  assert.equal(room.command.name, 'create-room');
  assert.equal(parseCommand('rev/room x').command, null);
  assert.equal(room.args, 'Plugin Showcase');
  assert.equal(room.typingName, false);
  assert.equal(parseCommand('rev/nope x').command, null);
});

test('lists matching commands, hiding room-only ones outside a room', () => {
  assert.deepEqual(matchCommands('', { inRoom: false }).map(c => c.name), ['go', 'join', 'dm', 'create-room', 'create-space', 'notifications']);
  assert.deepEqual(matchCommands('create', { inRoom: false }).map(c => c.name), ['create-room', 'create-space']);
  assert.deepEqual(matchCommands('i', { inRoom: true }).map(c => c.name), ['invite']);
  assert.deepEqual(matchCommands('i', { inRoom: false }), []);
  assert.deepEqual(matchCommands('no', { inRoom: false }).map(c => c.name), ['notifications']);
});

test('recognises IDs, addresses and names', () => {
  assert.equal(isMatrixId('@rin:matrix.org'), true);
  assert.equal(isMatrixId('@rin'), false);
  assert.equal(isRoomAddress('#atmos:matrix.org'), true);
  assert.equal(isRoomAddress('https://matrix.to/#/!abc:x.org?via=x.org'), true);
  assert.equal(isRoomAddress('atmos'), false);
  assert.equal(slugOf('Plugin Showcase!'), 'plugin-showcase');
});
