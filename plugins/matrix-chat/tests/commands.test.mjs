import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isCommand, isMatrixId, isRoomAddress, slugOf } from '../src/ui/commands.js';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('only text starting with rev/ is a command', () => {
  assert.equal(isCommand('rev/go x'), true);
  assert.equal(isCommand('  REV/join'), true);
  assert.equal(isCommand('@rin hello'), false);
  assert.equal(isCommand('see rev/go'), false);
});

test('recognises IDs, addresses and names', () => {
  assert.equal(isMatrixId('@rin:matrix.org'), true);
  assert.equal(isMatrixId('@rin'), false);
  assert.equal(isRoomAddress('#atmos:matrix.org'), true);
  assert.equal(isRoomAddress('https://matrix.to/#/!abc:x.org?via=x.org'), true);
  assert.equal(isRoomAddress('atmos'), false);
  assert.equal(slugOf('Plugin Showcase!'), 'plugin-showcase');
});

test('the commands are declared for Atmos\'s bar, with the Atmos that has it', () => {
  const manifest = JSON.parse(read('extension.json'));
  assert.equal(manifest.apiVersion, 4);
  assert.equal(manifest.engines.atmos, '>=0.20.0', 'atmos.commands is SDK 1.3 (Atmos 0.20.0)');
  assert.deepEqual(manifest.contributes.commands.map(command => command.name),
    ['go', 'join', 'dm', 'create-room', 'create-space', 'notifications', 'invite', 'leave']);
  for (const command of manifest.contributes.commands) {
    assert.match(command.name, /^[a-z][a-z0-9-]{0,29}$/);
    assert.equal(command.suggests, true, `rev/${command.name} lists what it would do`);
    assert.ok(command.about.length <= 120, command.name);
  }
});

test('the message bars hand rev/ to Atmos\'s bar; there\'s no command list of Matrix Chat\'s own', () => {
  for (const file of ['src/ui/room-view.js', 'src/ui/empty-view.js']) {
    const source = read(file);
    assert.match(source, /atmos\.commands\.bar\(composerEl\)/, file);
    assert.match(source, /atmos\.commands\.field\(input\)/, file);
    // Enter with a command (or, in the empty view, a room's name) hands it over the same way.
    assert.match(source, /input\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/, file);
    assert.doesNotMatch(source, /command-bar\.js/, file);
  }
  assert.match(read('boot.js'), /import\('\.\/src\/ui\/command-handlers\.js'\)/, 'answered in the background frame');
});
