/**
 * rev/ commands: what the message bars and the handlers share. The commands
 * themselves are declared in extension.json ("contributes.commands") and
 * answered by ui/command-handlers.js, in Atmos's command bar.
 */

/** Whether a message bar holds a command (text starting with rev/): Atmos's bar takes it. */
export function isCommand(text) {
  return /^\s*rev\//i.test(String(text || ''));
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
