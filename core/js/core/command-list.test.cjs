'use strict';
// rev/ commands: what Atmos's command bar offers for what's typed
// (command-list.js; the bar itself is command-bar.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('./command-list.js');
const PANELS = [
  { id: 'browser', label: 'Browser' }, { id: 'portfolio-tracker', label: 'Finance' },
  { id: 'audio-player', label: 'Music' }, { id: 'matrix-chat', label: 'Chat' },
];
const titles = result => result.rows.map(row => row.title ?? `note: ${row.note}`);

test('the prefix is optional, and "/" after a name is a space', async () => {
  const { parseCommand } = await load();
  for (const text of ['rev/switch finance', 'switch finance', 'rev/switch/finance', 'REV/Switch/finance', '  /switch   finance ', 'rev/switch//finance']) {
    const parsed = parseCommand(text);
    assert.equal(parsed.name, 'switch', text);
    assert.equal(parsed.args, 'finance', text);
    assert.equal(parsed.typingName, false, text);
    assert.equal(parsed.command?.name, 'switch', text);
  }
  assert.deepEqual({ ...parseCommand('rev/sw'), command: null }, { name: 'sw', args: '', typingName: true, command: null });
  assert.equal(parseCommand('rev/switch').typingName, true, 'still typing the name');
  assert.equal(parseCommand('rev/switch/').typingName, false);
  assert.equal(parseCommand('rev/switch ').typingName, false);
  assert.equal(parseCommand('').name, '');
  assert.equal(parseCommand('rev/nothing here').command, null);
});

test('isCommand: only text starting with rev/ (a message bar\'s commands)', async () => {
  const { isCommand } = await load();
  assert.equal(isCommand('rev/switch'), true);
  assert.equal(isCommand('  REV/x'), true);
  assert.equal(isCommand('switch finance'), false);
  assert.equal(isCommand('hey rev/'), false);
  assert.equal(isCommand(null), false);
});

test('nothing typed lists Atmos\'s commands in order', async () => {
  const { suggest } = await load();
  for (const text of ['', 'rev/', '/']) {
    assert.deepEqual(titles(suggest(text, { panels: PANELS })), ['rev/sidebar', 'rev/sidebar-side', 'rev/settings', 'rev/extensions', 'rev/switch', 'rev/widget', 'rev/wallpaper', 'rev/reload'], text);
  }
  const rows = suggest('', { panels: PANELS }).rows;
  // Enter runs a command that needs nothing more; one that needs a panel gets a space.
  assert.deepEqual(rows.find(row => row.title === 'rev/sidebar').enter, { run: { command: 'sidebar', target: null } });
  assert.deepEqual(rows.find(row => row.title === 'rev/settings').enter, { run: { command: 'settings', target: null } });
  assert.deepEqual(rows.find(row => row.title === 'rev/settings').tab, { complete: 'rev/settings ' });
  assert.deepEqual(rows.find(row => row.title === 'rev/switch').enter, { complete: 'rev/switch ' });
  assert.equal(rows.find(row => row.title === 'rev/switch').hint, 'panel');
});

test('typing narrows the commands; a panel or a page of Settings by name is offered too', async () => {
  const { suggest } = await load();
  assert.deepEqual(titles(suggest('rev/s', { panels: PANELS })), ['rev/sidebar', 'rev/sidebar-side', 'rev/settings', 'rev/switch'], 'one letter: commands only');
  assert.deepEqual(titles(suggest('rev/si', { panels: PANELS })), ['rev/sidebar', 'rev/sidebar-side', 'Settings → Sidebar']);
  const finance = suggest('rev/fin', { panels: PANELS, activePanel: 'browser' });
  assert.deepEqual(titles(finance), ['Finance']);
  assert.deepEqual(finance.rows[0].enter, { run: { command: 'switch', target: 'portfolio-tracker' } });
  assert.deepEqual(finance.rows[0].tab, { complete: 'rev/switch Finance' });
  assert.deepEqual(titles(suggest('music', { panels: PANELS })), ['Music'], 'without the prefix');
  assert.deepEqual(titles(suggest('appear', { panels: PANELS })), ['Settings → Appearance']);
  assert.deepEqual(suggest('appear').rows[0].enter, { run: { command: 'settings', target: 'appearance' } });
  assert.deepEqual(titles(suggest('rev/zz', { panels: PANELS })), ['note: There\'s no rev/zz.']);
});

test('rev/switch lists the panels, those starting with the text first; the one showing says so', async () => {
  const { suggest } = await load();
  assert.deepEqual(titles(suggest('rev/switch ', { panels: PANELS })), ['Browser', 'Finance', 'Music', 'Chat']);
  assert.deepEqual(titles(suggest('rev/switch/m', { panels: PANELS })), ['Music', 'Chat'], 'Music starts with m; so does matrix-chat, Chat\'s id');
  assert.deepEqual(titles(suggest('rev/switch/chat', { panels: PANELS })), ['Chat']);
  assert.deepEqual(titles(suggest('rev/switch/player', { panels: PANELS })), ['Music'], 'a word of the id (audio-player)');
  assert.deepEqual(titles(suggest('rev/switch/usi', { panels: PANELS })), ['note: No panel is called “usi”.'], 'not the middle of a word');
  assert.deepEqual(titles(suggest('rev/switch tracker', { panels: PANELS })), ['Finance'], 'by id too');
  const rows = suggest('rev/switch ', { panels: PANELS, activePanel: 'audio-player' }).rows;
  assert.equal(rows.find(row => row.title === 'Music').sub, 'Showing now');
  assert.equal(rows.find(row => row.title === 'Chat').sub, 'Switch to this panel');
  assert.deepEqual(titles(suggest('rev/switch nope', { panels: PANELS })), ['note: No panel is called “nope”.']);
});

test('rev/settings opens Settings, or a page of it', async () => {
  const { suggest, SETTINGS_PAGES } = await load();
  const all = suggest('rev/settings ');
  assert.deepEqual(titles(all), ['Settings', ...SETTINGS_PAGES.map(page => `Settings → ${page.label}`)]);
  assert.deepEqual(all.rows[0].enter, { run: { command: 'settings', target: null } });
  const appearance = suggest('rev/settings/appearance');
  assert.deepEqual(titles(appearance), ['Settings → Appearance']);
  assert.deepEqual(appearance.rows[0].enter, { run: { command: 'settings', target: 'appearance' } });
  assert.deepEqual(titles(suggest('settings ext')), ['Settings → Extensions']);
  assert.deepEqual(titles(suggest('rev/settings nope')), ['note: Settings has no page called “nope”.']);
});

test('a command that takes nothing more runs whatever follows; an unknown one says so', async () => {
  const { suggest } = await load();
  const sidebar = suggest('rev/sidebar now');
  assert.deepEqual(titles(sidebar), ['rev/sidebar']);
  assert.deepEqual(sidebar.rows[0].enter, { run: { command: 'sidebar', target: null } });
  assert.deepEqual(suggest('rev/extensions/').rows[0].enter, { run: { command: 'extensions', target: null } });
  assert.deepEqual(titles(suggest('rev/teleport home')), ['note: There\'s no rev/teleport. Clear it to see every command.']);
});

test('what\'s typed is never markup: rows carry it as text for the bar to escape', async () => {
  const { suggest } = await load();
  assert.equal(suggest('rev/<img').rows[0].note, 'There\'s no rev/<img.', 'the bar escapes notes and titles (command-bar.js uses escapeHtml)');
  assert.equal(suggest('rev/switch <img src=x>', { panels: PANELS }).rows[0].note, 'No panel is called “<img src=x>”.');
});

// ── Extensions' commands (SDK 1.3) ──────────────────────────────────────────
const MATRIX = {
  extension: 'plugin:matrix-chat', label: 'Matrix Chat', rank: 0,
  commands: [
    { name: 'go', args: 'room or person', about: 'Open one of your rooms or chats', takesArgs: true, suggests: true },
    { name: 'leave', args: '', about: 'Leave this room', takesArgs: false, suggests: true },
    { name: 'mute', args: '', about: 'Mute this room', takesArgs: false, suggests: false },
  ],
};
const AUDIO = { extension: 'plugin:audio-player', label: 'Audio Player', rank: 2, commands: [{ name: 'play', args: '', about: 'Play or pause', takesArgs: false, suggests: false }] };
const AWAY = { extension: 'plugin:dice', label: 'Dice', rank: 4, commands: [{ name: 'roll', args: 'dice', about: 'Roll some dice', takesArgs: true, suggests: false }] };
const SOURCES = [AWAY, AUDIO, MATRIX];

test('every command is listed, by what\'s showing: the panel\'s, widgets\', Atmos\'s own, then the rest, each under a heading', async () => {
  const { suggest, commandList } = await load();
  assert.deepEqual(commandList(SOURCES).map(command => `${command.name}:${command.rank}`),
    ['go:0', 'leave:0', 'mute:0', 'play:2', 'sidebar:3', 'sidebar-side:3', 'settings:3', 'extensions:3', 'switch:3', 'widget:3', 'wallpaper:3', 'reload:3', 'roll:4']);
  const all = suggest('', { sources: SOURCES });
  assert.deepEqual(all.rows.map(row => row.heading ?? row.title), [
    'Matrix Chat', 'rev/go', 'rev/leave', 'rev/mute', 'Audio Player', 'rev/play',
    'Atmos', 'rev/sidebar', 'rev/sidebar-side', 'rev/settings', 'rev/extensions', 'rev/switch', 'rev/widget', 'rev/wallpaper', 'rev/reload', 'Dice', 'rev/roll',
  ], 'Dice, with nothing showing, last');
  assert.ok(all.rows.filter(row => row.title).every(row => row.source === ''), 'under its heading, a row doesn\'t repeat whose it is');
  const away = { extension: 'plugin:abacus', label: 'Abacus', rank: 4, commands: [{ name: 'count', about: 'Count' }] };
  assert.deepEqual(suggest('', { sources: [AWAY, away] }).rows.filter(row => row.heading).map(row => row.heading), ['Atmos', 'Abacus', 'Dice'], 'those with nothing showing by name');
  assert.deepEqual(titles(suggest('r', { sources: SOURCES })), ['rev/reload', 'rev/roll'], 'typed, it\'s there (Atmos\'s own first)');
  assert.deepEqual(titles(suggest('rev/ro', { sources: SOURCES })), ['rev/roll']);
});

test('an extension\'s command: Enter runs it, or waits for what it takes or what it lists', async () => {
  const { suggest } = await load();
  const rows = suggest('', { sources: SOURCES }).rows;
  const row = title => rows.find(item => item.title === title);
  const matrix = name => ({ name, source: 'plugin:matrix-chat' });
  assert.deepEqual(row('rev/go').enter, { complete: 'rev/go ', prefer: matrix('go') }, 'completing it says whose it is (two extensions may share a name)');
  assert.deepEqual(row('rev/leave').enter, { complete: 'rev/leave ', prefer: matrix('leave') }, 'it lists what it would do: a second Enter does it');
  assert.deepEqual(row('rev/mute').enter, { run: { command: 'mute', source: 'plugin:matrix-chat', args: '', value: null } });
  assert.deepEqual(row('rev/play').enter, { run: { command: 'play', source: 'plugin:audio-player', args: '', value: null } });
  // Something typed after one that lists nothing runs with it.
  const roll = suggest('rev/roll 2d6', { sources: SOURCES });
  assert.deepEqual(titles(roll), ['rev/roll 2d6']);
  assert.deepEqual(roll.rows[0].enter, { run: { command: 'roll', source: 'plugin:dice', args: '2d6', value: null } });
  assert.equal(roll.ask, null);
});

test('one that lists: Atmos asks it, shows its last answer meanwhile, and runs the chosen row with its value', async () => {
  const { suggest } = await load();
  const waiting = suggest('rev/go gen', { sources: SOURCES });
  assert.deepEqual(waiting.ask, { source: 'plugin:matrix-chat', name: 'go', args: 'gen' });
  assert.deepEqual(titles(waiting), ['note: Asking Matrix Chat…']);
  const fetched = {
    source: 'plugin:matrix-chat', name: 'go', args: 'ge',
    rows: [{ heading: 'Rooms' }, { title: 'General', sub: 'Room', action: 'Open', value: '!general:example', complete: 'General', danger: false }, { note: 'And 3 more' }],
    options: [{ id: 'encrypted', type: 'toggle', label: 'encrypted', value: true }],
  };
  const answered = suggest('rev/go gen', { sources: SOURCES, fetched });
  assert.deepEqual(answered.rows.map(row => row.title ?? row.heading ?? row.note), ['Rooms', 'General', 'And 3 more']);
  assert.deepEqual(answered.rows[0], { heading: 'Rooms' });
  assert.deepEqual(answered.rows[1].enter, { run: { command: 'go', source: 'plugin:matrix-chat', args: 'gen', value: '!general:example' } });
  assert.equal(answered.rows[1].action, 'Open');
  assert.deepEqual(answered.rows[1].tab, { complete: 'rev/go General', prefer: { name: 'go', source: 'plugin:matrix-chat' } }, 'Tab types what the row says, never its value');
  assert.equal(answered.rows[1].stale, true, 'an answer for "ge" while "gen" is typed: Enter waits for this one\'s');
  assert.equal(suggest('rev/go ge', { sources: SOURCES, fetched }).rows[1].stale, false);
  assert.deepEqual(answered.options, fetched.options);
  // Another command's answer isn't this one's.
  assert.deepEqual(titles(suggest('rev/leave ', { sources: SOURCES, fetched })), ['note: Asking Matrix Chat…']);
  // A danger row stays one; an empty answer says so.
  const leave = suggest('rev/leave ', { sources: SOURCES, fetched: { source: 'plugin:matrix-chat', name: 'leave', args: '', rows: [{ title: 'Leave General', sub: '', action: 'Leave', value: null, danger: true }], options: [] } });
  assert.equal(leave.rows[0].danger, true);
  assert.equal(leave.rows[0].tab, null, 'nothing to complete: Tab moves on rather than running it');
  assert.deepEqual(leave.rows[0].enter, { run: { command: 'leave', source: 'plugin:matrix-chat', args: '', value: null } });
  assert.deepEqual(titles(suggest('rev/leave ', { sources: SOURCES, fetched: { source: 'plugin:matrix-chat', name: 'leave', args: '', rows: [], options: [] } })), ['note: Nothing to choose.']);
});

test('what an extension sends is cleaned: plain text, known shapes, a few of each', async () => {
  const { cleanSuggestions, cleanResult, cleanOptionValues } = await load();
  const cleaned = cleanSuggestions({
    rows: [
      { title: '  <b>General</b>\n room ', sub: 'x'.repeat(300), action: 'Open now please ok', value: 42, complete: ' General\n', danger: 'yes', onclick: 'alert(1)' },
      { heading: 'Public' }, { note: 'Searching…' }, { title: '' }, null, 'text', { title: 'Next', value: { nested: 1 } },
      { title: 'Intro', value: 'C:\\Music\\01  Intro\t(live).flac' },
    ],
    options: [
      { id: 'parent', type: 'select', label: 'in', value: '!a', options: [{ value: '', label: 'no space' }, { value: '!a', label: 'Atmos' }] },
      { id: 'access', type: 'select', style: 'chips', value: 'private', options: [{ value: 'private', label: 'invite only' }] },
      { id: 'encrypted', type: 'toggle', value: 'true' },
      { id: 'alias', type: 'text', value: 'general', prefix: '#', suffix: ':example.org', placeholder: 'address' },
      { id: 'bad id', type: 'toggle' }, { id: 'html', type: 'html' }, { id: 'empty', type: 'select', options: [] },
      { id: 5, type: 'toggle' }, { id: ['ab'], type: 'toggle' },
    ],
  });
  assert.deepEqual(cleaned.rows, [
    { title: '<b>General</b> room', sub: 'x'.repeat(160), action: 'Open now please ok', value: '42', complete: 'General', danger: false },
    { heading: 'Public' }, { note: 'Searching…' },
    { title: 'Next', sub: '', action: '', value: '', complete: '', danger: false },
    { title: 'Intro', sub: '', action: '', value: 'C:\\Music\\01  Intro\t(live).flac', complete: '', danger: false },
  ], 'markup stays text: the bar escapes it; a value is only handed back, so it\'s kept as sent');
  assert.deepEqual(cleaned.options.map(option => [option.id, option.type, option.value]), [
    ['parent', 'select', '!a'], ['access', 'select', 'private'], ['encrypted', 'toggle', false], ['alias', 'text', 'general'],
  ]);
  assert.equal(cleaned.options[0].style, 'dropdown');
  assert.equal(cleaned.options[1].style, 'chips');
  assert.deepEqual([cleaned.options[3].prefix, cleaned.options[3].suffix, cleaned.options[3].placeholder], ['#', ':example.org', 'address']);
  assert.deepEqual(cleanSuggestions([{ title: 'Just rows' }]).rows.map(row => row.title), ['Just rows']);
  assert.deepEqual(cleanSuggestions('nonsense'), { rows: [], options: [] });
  assert.equal(cleanSuggestions({ rows: Array.from({ length: 80 }, (_, index) => ({ title: `r${index}` })) }).rows.length, 50);

  assert.deepEqual(cleanResult({ done: 'Joined\n#general', keep: 1, fill: 'rev/create-room \n', options: { parent: '!s', x: { y: 1 } } }),
    { done: 'Joined #general', keep: false, fill: 'rev/create-room  ', options: { parent: '!s' } });
  assert.deepEqual(cleanResult(undefined), { done: '', keep: false, fill: null, options: null });
  assert.deepEqual(cleanResult({ keep: true }), { done: '', keep: true, fill: null, options: null });
  assert.deepEqual(cleanOptionValues({ a: true, b: 3, 'c d': 1, e: null, f: 'x'.repeat(300) }), { a: true, b: '3', f: 'x'.repeat(200) });
  assert.deepEqual(cleanOptionValues([1, 2]), {});
});

test('what an extension puts in the bar is one line of a command; it never chooses another extension\'s for the user', async () => {
  const { textFromExtension, fromAnotherExtension, ownCommand, suggest } = await load();
  assert.equal(textFromExtension('  rev/leav'), 'rev/leav');
  assert.equal(textFromExtension('rev/roll\n2'), 'rev/roll 2', 'one line');
  assert.equal(textFromExtension('hello'), 'rev/', 'not a command');
  assert.equal(textFromExtension(`rev/${'x'.repeat(300)}`).length, 200);
  const rows = suggest('rev/le', { sources: SOURCES }).rows;
  const leave = rows.find(row => row.title === 'rev/leave');
  assert.equal(fromAnotherExtension(leave, 'plugin:dice'), true, 'Matrix\'s, as far as Dice is concerned (completing into it counts)');
  assert.equal(fromAnotherExtension(leave, 'plugin:matrix-chat'), false, 'its own');
  const answered = suggest('rev/leave ', { sources: SOURCES, fetched: { source: 'plugin:matrix-chat', name: 'leave', args: '', rows: [{ title: 'Leave General', value: '!g', danger: true }], options: [] } });
  assert.equal(fromAnotherExtension(answered.rows[0], 'plugin:dice'), true);
  assert.equal(fromAnotherExtension(suggest('rev/switch', { sources: SOURCES }).rows[0], 'plugin:dice'), false, 'Atmos\'s own: going somewhere');
  assert.deepEqual(ownCommand('roll', 'plugin:dice', SOURCES), { name: 'roll', source: 'plugin:dice' });
  assert.equal(ownCommand('go', 'plugin:dice', SOURCES), null);
});

test('a name: Atmos\'s commands, panels and pages that start so, an extension\'s called that, then the rest', async () => {
  const { suggest } = await load();
  const PLAYER = { extension: 'plugin:audio-player', label: 'Audio Player', rank: 1, commands: [
    { name: 'play', about: 'Play or pause', takesArgs: false, suggests: false },
    { name: 'previous', about: 'Previous', takesArgs: false, suggests: false },
  ] };
  const SQUATTER = { extension: 'plugin:squatter', label: 'Squatter · community', rank: 0, commands: [
    { name: 'finance', about: 'Not Finance', takesArgs: false, suggests: false },
    { name: 'appearance', about: 'Not Settings', takesArgs: false, suggests: false },
    { name: 'finance-tips', about: 'Tips', takesArgs: false, suggests: false },
  ] };
  assert.deepEqual(titles(suggest('play', { panels: PANELS, sources: [PLAYER] })), ['rev/play', 'Music'], 'its own name before a panel matched by a word ("audio-player")');
  assert.deepEqual(titles(suggest('pl', { panels: PANELS, sources: [PLAYER] })), ['Music', 'rev/play']);
  assert.deepEqual(titles(suggest('finance', { panels: PANELS, sources: [SQUATTER] })), ['Finance', 'rev/finance', 'rev/finance-tips'], 'a panel by its name can\'t be pushed down');
  assert.deepEqual(titles(suggest('appearance', { panels: PANELS, sources: [SQUATTER] })), ['Settings → Appearance', 'rev/appearance'], 'nor a page of Settings');
  assert.deepEqual(titles(suggest('se', { panels: PANELS, sources: [SQUATTER] })), titles(suggest('se', { panels: PANELS })), 'what it doesn\'t start like, it leaves alone');
});

test('two extensions with one name: the text means the one whose row completed it', async () => {
  const { suggest } = await load();
  const COPYCAT = { extension: 'plugin:copycat', label: 'Copycat', rank: 0, commands: [{ name: 'go', about: 'Not Matrix', takesArgs: true, suggests: true }] };
  const sources = [COPYCAT, MATRIX];
  const listed = suggest('go', { sources });
  assert.deepEqual(listed.rows.map(row => row.source), ['Copycat', 'Matrix Chat'], 'both are listed, saying whose');
  const matrixRow = listed.rows[1];
  assert.deepEqual(matrixRow.enter, { complete: 'rev/go ', prefer: { name: 'go', source: 'plugin:matrix-chat' } });
  assert.equal(suggest('rev/go gen', { sources }).ask.source, 'plugin:copycat', 'unsaid: the first listed');
  assert.equal(suggest('rev/go gen', { sources, prefer: matrixRow.enter.prefer }).ask.source, 'plugin:matrix-chat', 'chosen: the one chosen');
  const fetched = { source: 'plugin:matrix-chat', name: 'go', args: 'gen', rows: [{ title: 'General', value: '!g' }], options: [] };
  assert.equal(suggest('rev/go gen', { sources, prefer: matrixRow.enter.prefer, fetched }).rows[0].source, 'Matrix Chat', 'its rows say whose, as the name has two owners');
  assert.equal(suggest('rev/go gen', { sources: [MATRIX], fetched }).rows[0].source, '', 'one owner: nothing to say');
});

test('Atmos\'s own commands without a key: the sidebar\'s side, the wallpaper, reloading', async () => {
  const { suggest, CORE_COMMANDS } = await load();
  const frames = require('./extension-frames.cjs');
  assert.deepEqual(CORE_COMMANDS.map(command => command.name), [...frames.CORE_COMMAND_NAMES], 'extensions can\'t take any of them');
  assert.deepEqual(suggest('rev/sidebar-side').rows[0].enter, { run: { command: 'sidebar-side', target: null } });
  assert.deepEqual(suggest('rev/reload').rows[0].enter, { run: { command: 'reload', target: null } });
  const wallpaper = suggest('rev/wallpaper ');
  assert.deepEqual(titles(wallpaper), ['rev/wallpaper paste', 'rev/wallpaper choose']);
  assert.deepEqual(wallpaper.rows[0].enter, { run: { command: 'wallpaper', target: 'paste' } });
  assert.deepEqual(titles(suggest('rev/wallpaper ch')), ['rev/wallpaper choose']);
  assert.deepEqual(titles(suggest('rev/wallpaper x')), ['note: rev/wallpaper takes paste or choose.']);
  assert.deepEqual(suggest('rev/wall').rows[0].enter, { run: { command: 'wallpaper', target: null } }, 'Enter on the name pastes');
});

const WIDGETS = [
  { id: 'portfolio-balance', label: 'Performance', enabled: true, open: false, docked: null, away: false },
  { id: 'spot', label: 'Spot', enabled: true, open: true, docked: 'top', away: false },
  { id: 'now-playing', label: 'Now Playing', enabled: false, open: false, docked: null, away: false },
];

test('rev/widget: a widget by name, then what to do with it, offered by its state', async () => {
  const { suggest } = await load();
  const at = text => suggest(text, { widgets: WIDGETS });
  assert.deepEqual(titles(at('rev/widget ')), ['Performance', 'Spot', 'Now Playing', 'All widgets']);
  assert.deepEqual(at('rev/widget per').rows[0].enter, { run: { command: 'widget', target: 'portfolio-balance:show' } }, 'Enter shows it');
  assert.deepEqual(at('rev/widget per').rows[0].tab, { complete: 'rev/widget Performance ' });
  assert.deepEqual(titles(at('rev/widget performance ')),
    ['Show: Performance', 'Unfold: Performance', 'Fold: Performance', 'Dock to top: Performance', 'Dock to bottom: Performance', 'Hide: Performance'], 'folded: unfold first');
  assert.deepEqual(titles(at('rev/widget spot ')),
    ['Show: Spot', 'Fold: Spot', 'Unfold: Spot', 'Undock: Spot', 'Dock to bottom: Spot', 'Hide: Spot'], 'open and docked to the top');
  assert.deepEqual(titles(at('rev/widget now playing ')), ['Show: Now Playing'], 'hidden: only bringing it back');
  assert.deepEqual(at('rev/widget perf fold').rows[0].enter, { run: { command: 'widget', target: 'portfolio-balance:fold' } }, 'the start of a name only one has');
  assert.deepEqual(at('rev/widget spot d').rows.map(row => row.enter.run.target), ['spot:bottom']);
  assert.deepEqual(titles(at('rev/widget all ')), ['Fold all', 'Unfold all']);
  assert.deepEqual(at('rev/widget all unf').rows[0].enter, { run: { command: 'widget', target: 'all:unfold' } });
  assert.deepEqual(titles(at('rev/widget spot zz')), ['note: Spot can’t “zz”. Clear it to see what it can do.']);
  assert.deepEqual(titles(at('rev/widget zz')), ['note: No widget is called “zz”.']);
  assert.deepEqual(titles(at('rev/perf')), ['Sidebar → Performance'], 'a widget by name, as a panel or a page');
  assert.deepEqual(at('rev/perf').rows[0].enter, { run: { command: 'widget', target: 'portfolio-balance:show' } });
});

test('a command\'s aliases find and run it, listed once (rev/pause is rev/play)', async () => {
  const { suggest } = await load();
  const AUDIO_PLAY = { extension: 'plugin:audio-player', label: 'Audio Player', rank: 2, commands: [{ name: 'play', aliases: ['pause'], about: 'Play or pause' }] };
  const at = text => suggest(text, { sources: [AUDIO_PLAY] });
  assert.deepEqual(titles(at('rev/pau')), ['rev/pause']);
  assert.equal(at('rev/pau').rows[0].sub, 'Play or pause · rev/play');
  assert.deepEqual(at('rev/pause').rows[0].enter, { run: { command: 'play', source: 'plugin:audio-player', args: '', value: null } }, 'runs as its own name');
  assert.deepEqual(titles(at('rev/pla')), ['rev/play']);
  assert.equal(at('rev/pla').rows[0].sub, 'Play or pause · rev/pause');
  assert.equal(at('').rows.filter(row => row.title === 'rev/play' || row.title === 'rev/pause').length, 1, 'listed once');
  assert.equal(at('rev/pause x').parsed.command.name, 'play');
});
