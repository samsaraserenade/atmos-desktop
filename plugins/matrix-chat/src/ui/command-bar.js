/**
 * rev/ commands in a message bar. Typing rev/ in the room view's composer
 * (or the empty view's bar) opens a list above it: the commands, then, once
 * one is chosen, what it can act on (your rooms, rooms in your spaces,
 * public rooms, people). ↑↓ choose, Enter runs, Tab completes, Esc clears.
 * While a command is in the bar, Enter never sends it as a message.
 *
 * rev/create-room and rev/create-space show their options as chips: which
 * space, who can join, encryption, and for public ones an address.
 */
import {
  addFriend, browsePublicRooms, canAddToSpace, createRoom, createSpace, getDirectRoomIds,
  getNotificationSound, getRooms, getSpaceChildren, getUserId, inviteToRoom, joinByAddress, joinPublicRoom, joinSpaceRoom,
  leaveRoom, onAccountChange, setNotificationSound,
} from './engine.js';
import { PREFIX, isCommand, parseCommand, matchCommands, isMatrixId, isRoomAddress, slugOf } from './commands.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const lower = value => String(value || '').toLowerCase();
const plural = (count, word) => `${Number(count).toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

function serverName() {
  const id = getUserId() || '';
  return id.includes(':') ? id.slice(id.indexOf(':') + 1) : '';
}

function joinedRooms() {
  return getRooms().filter(room => room.getMyMembership?.() === 'join');
}

function joinedSpaces() {
  return joinedRooms().filter(room => room.isSpaceRoom?.())
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

/** A DM's name is the other person's; everything else uses the room name. */
function roomLabel(room, directIds) {
  if (!directIds.has(room.roomId)) return room.name || room.roomId;
  const self = getUserId();
  const other = room.getJoinedMembers?.().find(member => member.userId !== self);
  return other?.name || room.name || room.roomId;
}

/** Spaces the room belongs to (its parents that you're in). */
function parentSpacesOf(roomId) {
  return joinedSpaces().filter(space => (space.currentState?.getStateEvents('m.space.child') || [])
    .some(event => event.getStateKey?.() === roomId && (event.getContent?.().via || []).length));
}

// Rooms in your spaces you haven't joined, from the space hierarchy API;
// shared by every bar, fetched when rev/join is typed, kept a minute.
const SPACE_CHILDREN_TTL = 60_000;
const spaceChildren = new Map(); // spaceId -> { rooms, at, loading }
const childrenListeners = new Set();

function loadSpaceChildren() {
  for (const space of joinedSpaces()) {
    const cached = spaceChildren.get(space.roomId);
    if (cached?.loading || (cached && Date.now() - cached.at < SPACE_CHILDREN_TTL)) continue;
    const state = { rooms: cached?.rooms || [], at: Date.now(), loading: true, spaceName: space.name || space.roomId };
    spaceChildren.set(space.roomId, state);
    getSpaceChildren(space.roomId).then(page => { state.rooms = page.rooms; })
      .catch(() => {})
      .finally(() => {
        state.loading = false;
        state.at = Date.now();
        for (const fn of [...childrenListeners]) fn();
      });
  }
}

const freshOptions = () => ({
  parent: null, access: 'private', accessTouched: false,
  encrypted: true, encryptedTouched: false, alias: '', aliasTouched: false, listed: false,
});

/**
 * Attach to a message bar. getRoom() is the open room (or null);
 * onOpenRoom(roomId) shows a room. Returns { active(), run(), dispose() }.
 */
export function attachCommandBar({ input, composerEl, getRoom = () => null, onOpenRoom }) {
  let listEl = null;
  let rows = [];
  let activeIndex = 0;
  let status = null; // { text, error }
  let busy = false;
  let options = freshOptions();
  let optionsFor = '';
  let publicQuery = '';
  let publicRooms = [];
  let publicLoading = false;
  let publicTimer = null;
  let disposed = false;

  const active = () => isCommand(input.value);

  function setInput(text) {
    input.value = text;
    input.focus();
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ── What each command offers ──
  function commandRows(parsed) {
    const room = getRoom();
    const found = matchCommands(parsed.name, { inRoom: !!room });
    if (!found.length) return [{ note: `There's no rev/${escapeHtml(parsed.name)}. Clear it to see every command.` }];
    return found.map(item => ({
      title: `${PREFIX}${item.name}`,
      hint: item.args,
      sub: item.about,
      run: () => {
        // Commands with text get a space to type it; rev/leave waits for a second Enter.
        setInput(`${PREFIX}${item.name}${item.takesArgs ? ' ' : ''}`);
        return 'keep';
      },
    }));
  }

  function openRow(room, directIds, sub) {
    return { title: escapeHtml(roomLabel(room, directIds)), sub, action: 'Open', run: () => ({ open: room.roomId }) };
  }

  function goRows(args) {
    const directIds = getDirectRoomIds();
    const query = lower(args);
    const matches = joinedRooms()
      .filter(room => !room.isSpaceRoom?.())
      .filter(room => !query || lower(roomLabel(room, directIds)).includes(query))
      .slice(0, 8);
    if (!matches.length) return [{ note: query ? 'None of your rooms or chats match.' : 'You\'re not in any rooms yet.' }];
    return matches.map(room => openRow(room, directIds, directIds.has(room.roomId) ? 'Direct message' : (parentSpacesOf(room.roomId)[0]?.name || 'Room')));
  }

  function joinRows(args) {
    if (isRoomAddress(args)) {
      return [{ title: `Join ${escapeHtml(args)}`, action: 'Join', run: async () => ({ open: (await joinByAddress(args))?.roomId }) }];
    }
    loadSpaceChildren();
    const query = lower(args);
    const joinedIds = new Set(joinedRooms().map(room => room.roomId));
    const out = [];
    const fromSpaces = [];
    for (const [, state] of spaceChildren) {
      for (const child of state.rooms) {
        if (joinedIds.has(child.roomId) || child.joinRule === 'invite') continue;
        if (query && !lower(child.name).includes(query) && !lower(child.topic).includes(query)) continue;
        fromSpaces.push({
          title: escapeHtml(child.name),
          sub: escapeHtml([`in ${state.spaceName}`, child.isSpace ? 'space' : null, plural(child.members, 'member')].filter(Boolean).join(' · ')),
          action: 'Join',
          run: async () => {
            await joinSpaceRoom(child.roomId, child.via);
            return child.isSpace ? { done: `Joined ${child.name}.` } : { open: child.roomId };
          },
        });
      }
    }
    if (fromSpaces.length) out.push({ heading: 'In your spaces' }, ...fromSpaces.slice(0, 8));
    else if ([...spaceChildren.values()].some(state => state.loading)) out.push({ note: 'Looking in your spaces…' });

    if (query.length >= 3) {
      if (publicQuery !== query) {
        publicQuery = query;
        publicRooms = [];
        publicLoading = true;
        clearTimeout(publicTimer);
        publicTimer = setTimeout(() => {
          browsePublicRooms({ search: args, limit: 8 }).then(result => {
            if (publicQuery === query) publicRooms = result;
          }).catch(() => { if (publicQuery === query) publicRooms = []; })
            .finally(() => {
              if (publicQuery !== query || disposed) return;
              publicLoading = false;
              paint();
            });
        }, 300);
      }
      const rooms = publicRooms.filter(room => !joinedIds.has(room.room_id));
      if (rooms.length) {
        out.push({ heading: 'Public rooms' }, ...rooms.map(room => ({
          title: escapeHtml(room.name || room.canonical_alias || room.room_id),
          sub: escapeHtml([plural(Number(room.num_joined_members || 0), 'member'), room.canonical_alias, room.topic].filter(Boolean).join(' · ')),
          action: 'Join',
          run: async () => ({ open: (await joinPublicRoom(room.canonical_alias || room.room_id))?.roomId }),
        })));
      } else if (publicLoading) out.push({ note: 'Searching public rooms…' });
    }
    if (!out.length) {
      out.push({ note: query ? 'Nothing matches. Paste a #room:server address or a matrix.to link to join it directly.'
        : 'Type to search your spaces and public rooms, or paste a #room:server address.' });
    }
    return out;
  }

  function dmRows(args) {
    const directIds = getDirectRoomIds();
    const out = [];
    if (isMatrixId(args)) {
      out.push({
        title: `Message ${escapeHtml(args.trim())}`,
        sub: 'Starts a private, encrypted chat, or opens the one you have',
        action: 'Message',
        run: async () => ({ open: (await addFriend(args.trim())).roomId }),
      });
    }
    const query = lower(args.replace(/^@/, '').split(':')[0]);
    const chats = joinedRooms().filter(room => directIds.has(room.roomId))
      .filter(room => !query || lower(roomLabel(room, directIds)).includes(query))
      .slice(0, 6);
    if (chats.length) out.push({ heading: 'Your chats' }, ...chats.map(room => openRow(room, directIds, 'Direct message')));
    if (!out.length) out.push({ note: 'Type their full Matrix ID, such as @name:matrix.org.' });
    return out;
  }

  function createRows(kind, args) {
    if (!args) return [{ note: `Type a name for the new ${kind}.` }];
    // Options belong to one command; typing another resets them.
    if (optionsFor !== kind) {
      options = freshOptions();
      optionsFor = kind;
      const room = getRoom();
      if (room) options.parent = parentSpacesOf(room.roomId).find(space => canAddToSpace(space.roomId))?.roomId || null;
    }
    if (!options.accessTouched) options.access = kind === 'room' && options.parent ? 'space' : 'private';
    if (options.access === 'space' && (kind === 'space' || !options.parent)) options.access = 'private';
    if (!options.encryptedTouched) options.encrypted = options.access !== 'public';
    if (!options.aliasTouched) options.alias = slugOf(args);
    const parentName = joinedSpaces().find(space => space.roomId === options.parent)?.name;
    return [{
      title: `Create ${kind} “${escapeHtml(args)}”`,
      sub: escapeHtml([parentName ? `in ${parentName}` : null,
        { private: 'invite only', space: 'anyone in the space', public: 'public' }[options.access],
        kind === 'room' && options.encrypted ? 'encrypted' : null].filter(Boolean).join(' · ')),
      action: 'Create',
      chips: kind,
      run: async () => {
        const request = { name: args, access: options.access, alias: options.alias, listed: options.listed, parentSpaceId: options.parent };
        if (kind === 'space') {
          const { roomId } = await createSpace(request);
          options = { ...freshOptions(), parent: roomId };
          optionsFor = 'room';
          setInput(`${PREFIX}create-room `);
          return { keep: true, done: `Created ${args}. Name its first room, or press Esc.` };
        }
        return { open: (await createRoom({ ...request, encrypted: options.encrypted })).roomId };
      },
    }];
  }

  function inviteRows(args) {
    const room = getRoom();
    if (!room) return [{ note: 'Open a room to invite someone to it.' }];
    if (!isMatrixId(args)) return [{ note: 'Type their full Matrix ID, such as @name:matrix.org.' }];
    return [{
      title: `Invite ${escapeHtml(args.trim())}`,
      sub: `to ${escapeHtml(room.name || room.roomId)}`,
      action: 'Invite',
      run: async () => { await inviteToRoom(room.roomId, args.trim()); return { done: `Invited ${args.trim()}.` }; },
    }];
  }

  function leaveRows() {
    const room = getRoom();
    if (!room) return [{ note: 'Open a room to leave it.' }];
    return [{
      title: `Leave ${escapeHtml(room.name || room.roomId)}`,
      sub: 'You can rejoin later if the room lets you',
      action: 'Leave',
      danger: true,
      run: async () => { await leaveRoom(room.roomId); return { done: `Left ${room.name || 'the room'}.` }; },
    }];
  }

  // The ping that plays for messages Matrix's push rules say notify you.
  // "rev/notifications" offers the other state; "on"/"off" pick one.
  function notificationRows(args) {
    const on = getNotificationSound();
    const wanted = /^(on|off)$/i.test(args) ? args.toLowerCase() === 'on' : !on;
    return [{
      title: `Ping sound ${wanted ? 'on' : 'off'}`,
      sub: wanted === on
        ? `It's already ${on ? 'on' : 'off'}`
        : (wanted ? 'Play a sound for messages that notify you' : 'Stay quiet when messages arrive'),
      action: wanted ? 'Turn on' : 'Turn off',
      run: () => {
        setNotificationSound(wanted);
        return { done: `Ping sound ${wanted ? 'on' : 'off'}.` };
      },
    }];
  }

  function buildRows() {
    const parsed = parseCommand(input.value);
    if (parsed.typingName) return commandRows(parsed);
    if (!parsed.command) return commandRows(parsed);
    switch (parsed.command.name) {
      case 'go': return goRows(parsed.args);
      case 'join': return joinRows(parsed.args);
      case 'dm': return dmRows(parsed.args);
      case 'create-room': return createRows('room', parsed.args);
      case 'create-space': return createRows('space', parsed.args);
      case 'invite': return inviteRows(parsed.args);
      case 'leave': return leaveRows();
      case 'notifications': return notificationRows(parsed.args);
      default: return commandRows(parsed);
    }
  }

  // ── Drawing ──
  const chip = (attrs, label, on) => `<button type="button" class="mx-palette-chip${on ? ' on' : ''}" ${attrs}>${label}</button>`;

  function chipsHtml(kind) {
    const spaces = joinedSpaces().filter(space => canAddToSpace(space.roomId));
    return `
      <div class="mx-palette-chips">
        ${spaces.length ? `<label class="mx-palette-chip mx-palette-chip-select${options.parent ? ' on' : ''}"><span>in</span>
          <select data-opt="parent" aria-label="In space">
            <option value="">no space</option>
            ${spaces.map(space => `<option value="${escapeHtml(space.roomId)}"${space.roomId === options.parent ? ' selected' : ''}>${escapeHtml(space.name || space.roomId)}</option>`).join('')}
          </select></label>` : ''}
        <span class="mx-palette-chip-group">
          ${chip('data-opt="access" data-value="private"', 'invite only', options.access === 'private')}
          ${kind === 'room' && options.parent ? chip('data-opt="access" data-value="space"', 'anyone in the space', options.access === 'space') : ''}
          ${chip('data-opt="access" data-value="public"', 'public', options.access === 'public')}
        </span>
        ${kind === 'room' ? chip('data-opt="encrypted"', 'encrypted', options.encrypted) : ''}
        ${options.access === 'public' ? `
          <label class="mx-palette-chip mx-palette-chip-alias on"><span>#</span><input data-opt="alias" value="${escapeHtml(options.alias)}" size="${Math.max(6, options.alias.length)}" spellcheck="false" aria-label="Address"><span>:${escapeHtml(serverName())}</span></label>
          ${chip('data-opt="listed"', 'list in directory', options.listed)}` : ''}
      </div>`;
  }

  function position() {
    const rect = composerEl.getBoundingClientRect();
    listEl.style.left = `${rect.left}px`;
    listEl.style.width = `${rect.width}px`;
    listEl.style.bottom = `${window.innerHeight - rect.top}px`;
  }

  function close() {
    listEl?.remove();
    listEl = null;
    rows = [];
    composerEl.classList.remove('mx-composer-command');
  }

  function paint() {
    if (disposed) return;
    if (!active()) {
      status = null;
      optionsFor = '';
      close();
      return;
    }
    rows = buildRows();
    const actionable = rows.map((row, index) => (row.run ? index : -1)).filter(index => index !== -1);
    if (!actionable.includes(activeIndex)) activeIndex = actionable[0] ?? -1;
    if (!listEl) {
      listEl = document.createElement('div');
      listEl.className = 'mx-palette';
      listEl.setAttribute('role', 'listbox');
      // mousedown keeps the input focused (and its caret) while choosing.
      listEl.addEventListener('mousedown', event => {
        if (event.target.closest('select, input')) return;
        event.preventDefault();
      });
      listEl.addEventListener('click', onListClick);
      listEl.addEventListener('change', onListChange);
      listEl.addEventListener('input', onListInput);
      document.body.appendChild(listEl);
    }
    composerEl.classList.add('mx-composer-command');
    const chipsFor = rows.find(row => row.chips)?.chips;
    listEl.innerHTML = `
      ${chipsFor ? chipsHtml(chipsFor) : ''}
      ${status ? `<div class="mx-palette-status${status.error ? ' mx-palette-status-error' : ''}" role="status">${escapeHtml(status.text)}</div>` : ''}
      <div class="mx-palette-list">
        ${rows.map((row, index) => row.heading
          ? `<div class="mx-palette-heading">${escapeHtml(row.heading)}</div>`
          : row.note
            ? `<div class="mx-palette-note">${row.note}</div>`
            : `<button type="button" class="mx-palette-item${index === activeIndex ? ' active' : ''}${row.danger ? ' danger' : ''}" data-index="${index}" role="option" aria-selected="${index === activeIndex}">
                <span class="mx-palette-item-text">
                  <span class="mx-palette-item-title">${row.title}${row.hint ? ` <span class="mx-palette-item-hint">${escapeHtml(row.hint)}</span>` : ''}</span>
                  ${row.sub ? `<span class="mx-palette-item-sub">${row.sub}</span>` : ''}
                </span>
                ${row.action ? `<span class="mx-palette-item-action">${busy && index === activeIndex ? '…' : escapeHtml(row.action)}</span>` : ''}
              </button>`).join('')}
      </div>
      <div class="mx-palette-foot">↑↓ choose · Enter run · Tab complete · Esc clear</div>`;
    position();
    listEl.querySelector('.mx-palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  // ── Running ──
  async function runRow(index) {
    const row = rows[index];
    if (!row?.run || busy) return;
    activeIndex = index;
    busy = true;
    status = null;
    paint();
    try {
      const result = await row.run();
      if (disposed) return;
      if (result === 'keep' || result?.keep) {
        if (result?.done) status = { text: result.done };
        return;
      }
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (result?.done) flash(result.done);
      if (result?.open) onOpenRoom?.(result.open);
    } catch (error) {
      if (!disposed) status = { text: error?.message || 'That didn\'t work. Try again.', error: true };
    } finally {
      busy = false;
      if (!disposed) paint();
    }
  }

  // Once the bar is cleared, what just happened shows as its placeholder for a moment.
  let flashTimer = null;
  let restPlaceholder = input.placeholder;
  function flash(text) {
    clearTimeout(flashTimer);
    input.placeholder = text;
    flashTimer = setTimeout(() => { if (!disposed) input.placeholder = restPlaceholder; }, 4000);
  }

  function runActive() {
    return runRow(activeIndex);
  }

  function move(step) {
    const actionable = rows.map((row, index) => (row.run ? index : -1)).filter(index => index !== -1);
    if (!actionable.length) return;
    const at = actionable.indexOf(activeIndex);
    activeIndex = actionable[(at + step + actionable.length) % actionable.length];
    paint();
  }

  // Capture on the composer, so these keys never reach its own handlers
  // (sending, the mention list) while a command is in the bar.
  function onKeyDown(event) {
    if (event.target !== input || !active()) return;
    const parsed = parseCommand(input.value);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      runActive();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      if (parsed.typingName) {
        const [first] = matchCommands(parsed.name, { inRoom: !!getRoom() });
        if (first) setInput(`${PREFIX}${first.name}${first.takesArgs ? ' ' : ''}`);
      } else move(1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      status = null;
      setInput('');
    }
  }

  function onListClick(event) {
    const option = event.target.closest('button[data-opt]');
    if (option) {
      const key = option.dataset.opt;
      if (key === 'access') { options.access = option.dataset.value; options.accessTouched = true; }
      if (key === 'encrypted') { options.encrypted = !options.encrypted; options.encryptedTouched = true; }
      if (key === 'listed') options.listed = !options.listed;
      paint();
      input.focus();
      return;
    }
    const item = event.target.closest('.mx-palette-item');
    if (item) runRow(Number(item.dataset.index));
  }

  function onListChange(event) {
    if (event.target.dataset.opt !== 'parent') return;
    options.parent = event.target.value || null;
    options.accessTouched = false;
    paint();
    input.focus();
  }

  function onListInput(event) {
    if (event.target.dataset.opt !== 'alias') return;
    options.alias = event.target.value.replace(/^#/, '').replace(/:.*$/, '');
    options.aliasTouched = true;
    event.target.size = Math.max(6, options.alias.length);
  }

  const onInput = () => {
    if (status && !busy && !status.error) status = null;
    paint();
  };
  const onBlur = () => setTimeout(() => {
    if (!disposed && document.activeElement !== input && !listEl?.contains(document.activeElement)) close();
  }, 120);
  const onFocus = () => { if (active()) paint(); };
  const onResize = () => { if (listEl) position(); };
  const onChildren = () => { if (listEl) paint(); };

  composerEl.addEventListener('keydown', onKeyDown, true);
  input.addEventListener('input', onInput);
  input.addEventListener('blur', onBlur);
  input.addEventListener('focus', onFocus);
  window.addEventListener('resize', onResize);
  childrenListeners.add(onChildren);
  const offAccount = onAccountChange(() => { spaceChildren.clear(); close(); });

  return {
    active,
    run: runActive,
    /** Put text in the bar (the sidebar's "+"), optionally with a space for a new room. */
    fill(text, { parentSpaceId } = {}) {
      if (parentSpaceId) {
        options = { ...freshOptions(), parent: parentSpaceId };
        optionsFor = parseCommand(text).name === 'create-space' ? 'space' : 'room';
      }
      setInput(text);
    },
    dispose() {
      disposed = true;
      clearTimeout(publicTimer);
      clearTimeout(flashTimer);
      input.placeholder = restPlaceholder;
      close();
      composerEl.removeEventListener('keydown', onKeyDown, true);
      input.removeEventListener('input', onInput);
      input.removeEventListener('blur', onBlur);
      input.removeEventListener('focus', onFocus);
      window.removeEventListener('resize', onResize);
      childrenListeners.delete(onChildren);
      offAccount?.();
    },
  };
}
