import { renderRoomList } from '../src/ui/room-list.js';
import { reconcileMarkup } from '../src/ui/reconcile-markup.js';
import { setRooms, emit, listenerCount, spaceChildren, joinedChildren, matrixState } from './browser-mocks.js';
import { setLoggedIn } from './browser-mocks.js';
import { sanitizeHtml, linkifyText, MAX_HTML_LENGTH } from '../src/ui/html-sanitizer.js';

function assert(value, message) { if (!value) throw new Error(message); }
const tick = () => new Promise(resolve => queueMicrotask(resolve));

// Message HTML from other people, after sanitizing and being inserted the
// way message-render.js does it (innerHTML), must hold nothing that runs,
// loads from outside Matrix, or restyles the app.
const ALLOWED_AFTER = new Set(['FONT', 'DEL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'P', 'A', 'UL', 'OL', 'SUP', 'SUB', 'LI', 'B', 'I', 'U', 'STRONG', 'EM', 'STRIKE', 'CODE', 'HR', 'BR', 'DIV', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'CAPTION', 'PRE', 'SPAN', 'IMG', 'DETAILS', 'SUMMARY']);
function assertSafe(input, html) {
  const box = document.createElement('div');
  box.innerHTML = html;
  for (const el of box.querySelectorAll('*')) {
    assert(ALLOWED_AFTER.has(el.tagName), `sanitizer let <${el.tagName.toLowerCase()}> through: ${input}`);
    for (const attr of el.attributes) {
      assert(!/^on/i.test(attr.name), `event handler ${attr.name} survived: ${input}`);
      assert(attr.name !== 'style', `style attribute survived: ${input}`);
      if (attr.name === 'href') assert(/^(https?:|mailto:|mxc:|matrix:|#)/i.test(attr.value.trim()) || !/:/.test(attr.value), `unsafe href ${attr.value}: ${input}`);
      assert(attr.name !== 'src', `an image src survived (only data-mx-src for mxc: may): ${input}`);
      if (attr.name === 'class') assert(el.tagName === 'CODE' && /^language-/.test(attr.value), `class ${attr.value} survived: ${input}`);
    }
  }
  return box;
}
const XSS = [
  '<img src=x onerror=alert(1)>',
  '<img src="https://tracker.example/pixel.png">',
  '<a href="javascript:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="jav&#x09;ascript:alert(1)">x</a>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<svg><script>alert(1)</script></svg>',
  '<svg onload=alert(1)><animate onbegin=alert(1)>',
  '<math><mi><mglyph><style><img src=x onerror=alert(1)></style></mglyph></mi></math>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  '<style>body{display:none}</style><div style="position:fixed;inset:0">cover</div>',
  '<iframe src="https://example.org"></iframe><object data="x"></object><embed src="x">',
  '<form action="https://example.org"><input autofocus onfocus=alert(1)><button>go</button></form>',
  '<details open ontoggle=alert(1)><summary>x</summary></details>',
  '<code class="mx-login mx-login-card">spoof</code>',
  '<table><tr><td><a href="https://example.org" onclick="alert(1)">ok</a></td></tr></table>',
  '<p>fine <b>bold</b> <a href="https://matrix.org">link</a></p>',
];
for (const input of XSS) assertSafe(input, sanitizeHtml(input));
{
  const box = assertSafe('mxc', sanitizeHtml('<img src="mxc://matrix.org/abc" alt="e"><code class="language-js">x</code>'));
  assert(box.querySelector('img').dataset.mxSrc === 'mxc://matrix.org/abc', 'mxc images are kept for Atmos to fetch');
  assert(box.querySelector('code').className === 'language-js', 'code language classes are kept');
  assert(box.querySelector('a') === null, 'no stray links');
  const link = assertSafe('link', sanitizeHtml('<a href="https://matrix.org">m</a>')).querySelector('a');
  assert(link.getAttribute('rel') === 'noopener noreferrer' && link.getAttribute('target') === '_blank', 'links open outside, without a reference back');
  const text = assertSafe('linkify', linkifyText('<b>"x"</b> https://a.example/?q="><img src=x onerror=alert(1)>'));
  assert(!text.querySelector('b, img'), 'plain text stays text');
  let threw = false;
  try { sanitizeHtml('x'.repeat(MAX_HTML_LENGTH + 1)); } catch { threw = true; }
  assert(threw, 'oversized HTML is refused (the plain body is shown instead)');
}

try {
  const container = document.createElement('div');
  document.body.append(container);
  let selections = 0;
  const baseline = listenerCount();
  const cleanup = renderRoomList(container, { onSelectRoom: () => selections++ });
  assert(container.textContent.includes('No rooms'), 'empty state mounts');
  const makeRoom = (id, name) => ({
    roomId: id, name,
    getMyMembership: () => 'join',
    getLiveTimeline: () => ({ getEvents: () => [] }),
    getUnreadNotificationCount: () => 0,
  });
  const room = makeRoom('!one', 'First');
  setRooms([room, makeRoom('!two', 'Second')]);
  emit('sync', 'PREPARED');
  await tick();
  const row = container.querySelector('[data-room-id="!one"]');
  assert(row, 'empty list receives first sync without remount');
  row.click();
  for (let i = 0; i < 5; i++) { emit('sync', 'SYNCING'); emit('receipt'); }
  await tick();
  assert(row === container.querySelector('[data-room-id="!one"]'), 'unchanged row identity survives sync');
  assert(row.classList.contains('active'), 'selection survives sync');
  row.click();
  assert(selections === 2, 'event handlers do not accumulate');
  room.name = 'Renamed';
  emit('room', room);
  await tick();
  assert(row === container.querySelector('[data-room-id="!one"]'), 'updated row retains identity');
  assert(row.textContent.includes('Renamed'), 'updated room name renders');
  let avatarSource = 'mxc://test/avatar';
  room.getMxcAvatarUrl = () => avatarSource;
  emit('room', room);
  await tick(); await tick(); await tick();
  const photo = row.querySelector('.mx-room-avatar img');
  assert(photo, 'avatar hydrates into existing row');
  emit('sync', 'SYNCING');
  await tick(); await tick();
  assert(row.querySelector('.mx-room-avatar img') === photo, 'sync preserves hydrated photo element');
  avatarSource = null;
  emit('room', room);
  await tick(); await tick();
  assert(!row.querySelector('.mx-room-avatar img'), 'removed avatar restores fallback');
  cleanup.update('!two');
  await tick();
  assert(container.querySelector('[data-room-id="!two"]').classList.contains('active'), 'external navigation updates selection');

  const child = makeRoom('!child', 'Project room');
  child.isSpaceRoom = () => false;
  const space = makeRoom('!space', 'Project space');
  space.isSpaceRoom = () => true;
  space.currentState = { getStateEvents: () => [{
    getContent: () => ({ via: ['test'] }),
    getStateKey: () => child.roomId,
  }] };
  spaceChildren.rooms = [
    { roomId: '!child', name: 'Project room', members: 3, joinRule: 'restricted', isSpace: false, via: ['test'] },
    { roomId: '!new', name: 'Not joined yet', members: 8, joinRule: 'restricted', isSpace: false, via: ['test'] },
  ];
  setRooms([space, child]);
  emit('sync', 'SYNCING');
  cleanup.update(child.roomId);
  await tick(); await tick();
  const spaceToggle = container.querySelector('[data-space-id="!space"]');
  assert(spaceToggle, 'spaces render as nested accordions');
  assert(spaceToggle.getAttribute('aria-expanded') === 'true', 'space containing active room opens automatically');
  assert(container.querySelector('[data-room-id="!child"]'), 'expanded space reveals its room rows');
  // Rooms in the space you're not in yet come from the hierarchy, faded, with Join.
  await new Promise(resolve => setTimeout(resolve, 0));
  await tick(); await tick();
  const unjoined = container.querySelector('[data-child-id="!new"]');
  assert(unjoined && unjoined.querySelector('[data-join-child]'), 'unjoined space rooms show with a Join button');
  assert(!container.querySelector('[data-child-id="!child"]'), 'joined rooms are not listed twice');
  assert(!container.querySelector('[data-space-add]'), 'no + buttons in the list');
  const selectionsBeforeJoin = selections;
  unjoined.querySelector('[data-join-child]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(joinedChildren.length === 1 && joinedChildren[0][0] === '!new' && joinedChildren[0][1][0] === 'test', 'Join uses the space\'s via servers');
  assert(selections === selectionsBeforeJoin + 1, 'joining a room opens it');
  assert(matrixState.openSpaces.includes('!space'), 'open groups are saved');
  spaceToggle.click();
  assert(container.querySelector('[data-entry-id="!space"] .mx-space-group-rooms').hidden, 'space accordion can be collapsed');
  assert(!matrixState.openSpaces.includes('!space'), 'closing a space is saved');

  const beforeCleanup = container.innerHTML;
  emit('sync', 'SYNCING');
  cleanup();
  setRooms([]);
  await tick();
  assert(container.innerHTML === beforeCleanup, 'queued repaint cannot run after disposal');
  assert(listenerCount() === baseline, 'view subscriptions return to baseline');

  const markup = '<div class="list"><div class="row" data-room-id="a"><span class="avatar">A</span><span class="name">Alice</span></div><div class="row" data-room-id="b">Bob</div></div>';
  reconcileMarkup(container, markup);
  const first = container.querySelector('[data-room-id="a"]');
  const avatar = first.querySelector('.avatar');
  avatar.innerHTML = '<img alt="hydrated">';
  const hydrated = avatar.firstChild;
  reconcileMarkup(container, markup.replace('Alice', 'Alice updated'));
  assert(avatar.firstChild === hydrated, 'unmodified hydrated avatar is preserved');
  reconcileMarkup(container, '<div class="list"><div class="row" data-room-id="b">Bob</div><div class="row" data-room-id="a"><span class="avatar">A</span><span class="name">Alice updated</span></div></div>');
  assert(container.querySelector('.list').lastChild === first, 'keyed reorder moves existing row');
  // The panel frame's entry mounts itself when imported.
  await import('../panel.js');
  const panel = document.querySelector('.mx-panel-root');
  assert(panel.textContent === 'LOGIN', 'panel mounts logged out');
  setLoggedIn(true);
  emit('account', { userId: '@new:test' });
  assert(panel.textContent.includes('EMPTY'), 'signing in with no room open shows the empty view');
  emit('account', { userId: '@other:test' });
  assert(panel.textContent.includes('EMPTY'), 'account switch replaces main view');
  setRooms([makeRoom('!open', 'Open me')]);
  emit('view', { type: 'room', roomId: '!open' });
  assert(panel.textContent.includes('ROOM'), 'the shared view opens a room');
  setLoggedIn(false);
  emit('account', { userId: null });
  assert(panel.textContent === 'LOGIN', 'logout returns to login');
  document.body.textContent = 'PASS: sanitizer attack corpus; room list lifecycle, keyed updates, selection, hydration and disposal';
} catch (error) {
  document.body.textContent = 'FAIL: ' + error.stack;
}
