/**
 * rev/ commands typed into a message bar. Pure: parsing and matching only;
 * ui/command-bar.js shows the suggestions and runs them.
 */
export const PREFIX = 'rev/';

export const COMMANDS = Object.freeze([
  { name: 'go', args: 'room or person', about: 'Open one of your rooms or chats', takesArgs: true },
  { name: 'join', args: '#room:server, a link, or search', about: 'Join a room or space', takesArgs: true },
  { name: 'dm', args: '@name:server', about: 'Message someone', takesArgs: true },
  { name: 'create-room', args: 'name', about: 'Create a room', takesArgs: true },
  { name: 'create-space', args: 'name', about: 'Create a space', takesArgs: true },
  { name: 'notifications', args: 'on or off', about: 'Turn the ping for new messages on or off', takesArgs: true },
  { name: 'invite', args: '@name:server', about: 'Invite someone to this room', takesArgs: true, needsRoom: true },
  { name: 'leave', args: '', about: 'Leave this room', needsRoom: true },
].map(Object.freeze));

/** Whether the bar holds a command (a message starting with rev/). */
export function isCommand(text) {
  return /^\s*rev\//i.test(String(text || ''));
}

/**
 * Split "rev/create-room Plugin Showcase" into { name: 'create-room', args: 'Plugin
 * Showcase', command, typingName }. typingName is true until a space
 * follows the name, while the command list is still being narrowed.
 */
export function parseCommand(text) {
  const body = String(text || '').trimStart().slice(PREFIX.length);
  const match = /^(\S*)(\s+([\s\S]*))?$/.exec(body) || [];
  const name = (match[1] || '').toLowerCase();
  return {
    name,
    args: (match[3] || '').trim(),
    typingName: match[2] === undefined,
    command: COMMANDS.find(item => item.name === name) || null,
  };
}

/** Commands whose names start with what's typed; room-only ones need a room. */
export function matchCommands(name, { inRoom = false } = {}) {
  const query = String(name || '').toLowerCase();
  return COMMANDS.filter(item => item.name.startsWith(query) && (inRoom || !item.needsRoom));
}

export const isMatrixId = value => /^@[^\s:]+:[^\s]+$/.test(String(value || '').trim());
export const isRoomAddress = value => {
  const text = String(value || '').trim();
  return /^https?:\/\/matrix\.to\/#\//i.test(text) || /^[#!][^\s:]+:[^\s]+$/.test(text);
};

/** A room address part from a name: "Plugin Showcase" -> "plugin-showcase". */
export function slugOf(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[^\w\s.-]/g, '')
    .trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 64);
}
