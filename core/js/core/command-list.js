/**
 * rev/ commands: what Atmos's command bar (command-bar.js) offers for what's
 * typed. Pure: parsing, matching and cleaning what extensions send, so it can
 * be tested on its own.
 *
 * In Atmos's own bar everything typed is a command, so the prefix is
 * optional ("switch finance"); a message bar that also takes commands
 * (Matrix Chat's) needs it to tell the two apart ("rev/switch finance").
 * After a command's name, "/" and a space are the same: rev/switch/finance.
 *
 * Commands are Atmos's own (CORE_COMMANDS) and those extensions declare in
 * "contributes.commands" (SDK 1.3), all listed, by what's showing: the
 * panel the bar is for, other panels, widgets, Atmos's own, then
 * extensions with nothing showing (by name), each under a heading.
 */
export const PREFIX = 'rev/';

/** Atmos's own commands, in the order the bar lists them. */
export const CORE_COMMANDS = Object.freeze([
  { name: 'sidebar', about: 'Open or close the sidebar' },
  { name: 'settings', args: 'page', about: 'Open Settings, or one of its pages', optionalArgs: true },
  { name: 'extensions', about: 'Install, update and remove extensions' },
  { name: 'switch', args: 'panel', about: 'Show another panel', takesArgs: true },
].map(Object.freeze));

/** Settings' pages, as `rev/settings <page>` names them. */
export const SETTINGS_PAGES = Object.freeze([
  { id: 'atmos', label: 'Atmos' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'sidebar', label: 'Sidebar' },
  { id: 'panels', label: 'Panels' },
  { id: 'browser', label: 'Browser' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'system', label: 'System' },
].map(Object.freeze));

// Where Atmos's own commands sit among extensions' (see commandList()).
const CORE_RANK = 3;

/** Whether a message bar holds a command (text starting with rev/). */
export function isCommand(text) {
  return /^\s*rev\//i.test(String(text || ''));
}

/**
 * Split "rev/switch/finance" (or "switch finance", or "/switch finance")
 * into { name: 'switch', args: 'finance', typingName, command }.
 * typingName is true until something follows the name, while the list of
 * commands is still being narrowed.
 */
export function parseCommand(text, commands = CORE_COMMANDS) {
  const body = String(text || '').trimStart().replace(/^rev\//i, '').replace(/^\//, '');
  const match = /^([^\s/]*)([\s/]+([\s\S]*))?$/.exec(body) || [];
  const name = (match[1] || '').toLowerCase();
  return {
    name,
    args: (match[3] || '').trim(),
    typingName: match[2] === undefined,
    command: commands.find(item => item.name === name) || null,
  };
}

const lower = value => String(value || '').toLowerCase();

/** Commands whose names start with what's typed. */
export function matchCommands(name, commands = CORE_COMMANDS) {
  const query = lower(name);
  return commands.filter(item => item.name.startsWith(query));
}

const words = value => lower(value).split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Targets ({ id, label }) whose label or id starts with the query, then
 * those with a word that does ("chat" finds matrix-chat), each in their own
 * order. Not the middle of a word: "si" isn't Music.
 */
export function matchTargets(query, targets) {
  const { starts, wordStarts } = targetMatches(query, targets);
  return [...starts, ...wordStarts];
}

function targetMatches(query, targets) {
  const text = lower(query).trim();
  if (!text) return { starts: [...targets], wordStarts: [] };
  const starts = [], wordStarts = [];
  for (const target of targets) {
    const label = lower(target.label), id = lower(target.id);
    if (label.startsWith(text) || id.startsWith(text)) starts.push(target);
    else if ([...words(label), ...words(id)].some(word => word.startsWith(text))) wordStarts.push(target);
  }
  return { starts, wordStarts };
}

/**
 * Every command in the order the bar lists them, each with `source` (the
 * extension's "plugin:<id>", or null for Atmos's own), `sourceLabel` and
 * `rank`. `sources` is what extension-frame-host.js extensionCommandSources()
 * gives: [{ extension, label, rank, commands }].
 */
export function commandList(sources = []) {
  const of = source => (source.commands || []).map(command => ({ ...command, source: source.extension, sourceLabel: source.label, rank: source.rank }));
  // By what's showing; extensions equally far away by name.
  const sorted = [...sources].sort((a, b) => a.rank - b.rank || String(a.label).localeCompare(String(b.label)));
  return [
    ...sorted.filter(source => source.rank < CORE_RANK).flatMap(of),
    ...CORE_COMMANDS.map(command => ({ ...command, source: null, sourceLabel: null, rank: CORE_RANK })),
    ...sorted.filter(source => source.rank > CORE_RANK).flatMap(of),
  ];
}

const runs = (command, target = null) => ({ run: { command, target } });
const runsExtension = (command, source, args = '', value = null) => ({ run: { command: command.name, source, args, value } });
// `prefer`: the command the text is for when two share its name (the one whose row completed it).
const completes = (text, prefer = null) => (prefer ? { complete: text, prefer } : { complete: text });
const ownedBy = item => (item.source ? { name: item.name, source: item.source } : null);

function panelRow(panel, activePanel) {
  return {
    title: panel.label || panel.id,
    sub: panel.id === activePanel ? 'Showing now' : 'Switch to this panel',
    action: 'Switch',
    enter: runs('switch', panel.id),
    tab: completes(`${PREFIX}switch ${panel.label || panel.id}`),
  };
}

function pageRow(page) {
  return {
    title: `Settings → ${page.label}`,
    sub: 'Open this page of Settings',
    action: 'Open',
    enter: runs('settings', page.id),
    tab: completes(`${PREFIX}settings ${page.label}`),
  };
}

/**
 * Every command, under a heading for each extension (Atmos's under
 * "Atmos"), when they come from more than one; rows under a heading don't
 * repeat whose they are.
 */
function grouped(commands) {
  const groups = [];
  for (const item of commands) {
    const key = item.source || '';
    if (groups.at(-1)?.key !== key) groups.push({ key, label: item.sourceLabel || 'Atmos', items: [] });
    groups.at(-1).items.push(item);
  }
  if (groups.length < 2) return commands.map(commandRow);
  return groups.flatMap(group => [{ heading: group.label }, ...group.items.map(item => ({ ...commandRow(item), source: '' }))]);
}

/** A command as a row while its name is being typed. */
function commandRow(item) {
  // Something to type, or choices to pick from (rev/leave's "Leave X"):
  // Enter gives it a space. The rest run.
  const more = item.takesArgs || (item.source && item.suggests);
  return {
    title: `${PREFIX}${item.name}`,
    hint: item.args || '',
    sub: item.about || '',
    source: item.sourceLabel || '',
    enter: more ? completes(`${PREFIX}${item.name} `, ownedBy(item)) : item.source ? runsExtension(item, item.source) : runs(item.name),
    tab: completes(`${PREFIX}${item.name}${more || item.optionalArgs ? ' ' : ''}`, ownedBy(item)),
  };
}

/** The list with `prefer` (a name and its extension) first among those of its name, so the text resolves to it. */
function preferring(commands, prefer) {
  if (!prefer) return commands;
  const chosen = item => item.name === prefer.name && item.source === prefer.source;
  return [...commands.filter(chosen), ...commands.filter(item => !chosen(item))];
}

/**
 * What the bar lists for `text`:
 *   { parsed, rows, ask, options }
 *   rows     { title, hint, sub, source, action, danger, stale, enter, tab }
 *            where enter and tab are { run: { command, target } } (Atmos's),
 *            { run: { command, source, args, value } } (an extension's) or
 *            { complete: text, prefer? }, and tab may be null (nothing to
 *            complete: Tab moves on); stale: an extension's row answering
 *            what was typed before (Enter waits for the answer to this);
 *            or { heading } / { note }
 *   ask      { source, name, args }: the extension to ask what to list
 *            (its command declares "suggests"), or null
 *   options  the options that extension offers, as it last said
 *
 *   panels        [{ id, label }] the panels there are (panel-registry.js)
 *   activePanel   the id of the one showing
 *   pages         Settings' pages (SETTINGS_PAGES)
 *   sources       extensions' commands (commandList())
 *   fetched       the extension's last answer for its command:
 *                 { source, name, args, rows, options } (cleanSuggestions())
 *   prefer        { name, source }: which command the text means when two
 *                 extensions declare its name (the row that completed it)
 */
export function suggest(text, { panels = [], activePanel = null, pages = SETTINGS_PAGES, sources = [], fetched = null, prefer = null } = {}) {
  const commands = commandList(sources);
  const parsed = parseCommand(text, preferring(commands, prefer));
  const result = rows => ({ parsed, rows, ask: null, options: [] });
  if (parsed.typingName) {
    // Nothing typed yet: every command, by what's showing (the panel the
    // bar is for first), each extension's under its name.
    if (!parsed.name) return result(grouped(commands));
    // A name: Atmos's commands; a panel or a page of Settings whose name
    // starts so (rev/finance, rev/appearance); an extension's command called
    // that; a panel or page with a word that starts so (rev/play's Music,
    // "audio-player"); then extensions' commands that start so. An
    // extension can't push Atmos's own places down by naming a command
    // after one.
    const found = matchCommands(parsed.name, commands);
    const named = parsed.name.length >= 2;
    const panelHits = named ? targetMatches(parsed.name, panels) : { starts: [], wordStarts: [] };
    const pageHits = named ? targetMatches(parsed.name, pages) : { starts: [], wordStarts: [] };
    const rows = [
      ...found.filter(item => !item.source).map(commandRow),
      ...panelHits.starts.map(panel => panelRow(panel, activePanel)),
      ...pageHits.starts.map(pageRow),
      ...found.filter(item => item.source && item.name === parsed.name).map(commandRow),
      ...panelHits.wordStarts.map(panel => panelRow(panel, activePanel)),
      ...pageHits.wordStarts.map(pageRow),
      ...found.filter(item => item.source && item.name !== parsed.name).map(commandRow),
    ];
    return result(rows.length ? rows : [{ note: `There's no ${PREFIX}${parsed.name}.` }]);
  }
  const { command, args } = parsed;
  if (!command) return result([{ note: `There's no ${PREFIX}${parsed.name}. Clear it to see every command.` }]);

  if (command.source) {
    if (!command.suggests) {
      return result([{
        title: `${PREFIX}${command.name}${args ? ` ${args}` : ''}`, sub: command.about || '', source: command.sourceLabel || '',
        action: 'Run', enter: runsExtension(command, command.source, args), tab: completes(`${PREFIX}${command.name} ${args}`, ownedBy(command)),
      }]);
    }
    const ask = { source: command.source, name: command.name, args };
    // Its last answer for this command stands until the next arrives.
    const answer = fetched && fetched.source === command.source && fetched.name === command.name ? fetched : null;
    if (!answer) return { parsed, rows: [{ note: `Asking ${command.sourceLabel || 'the extension'}…` }], ask, options: [] };
    // An answer for what was typed before shows until this one's comes; Enter waits for it.
    const stale = answer.args !== args;
    // Whose these are, when another extension has a command of this name too.
    const shared = commands.filter(item => item.name === command.name).length > 1;
    const rows = answer.rows.map(row => (row.heading !== undefined || row.note !== undefined ? row : {
      title: row.title, sub: row.sub, source: shared ? command.sourceLabel || '' : '', action: row.action || 'Run', danger: row.danger === true, stale,
      enter: runsExtension(command, command.source, args, row.value),
      // Tab puts what the row says to type in the bar (rev/go General); a row without, Tab passes over.
      tab: row.complete ? completes(`${PREFIX}${command.name} ${row.complete}`, ownedBy(command)) : null,
    }));
    return { parsed, rows: rows.length ? rows : [{ note: 'Nothing to choose.' }], ask, options: answer.options };
  }

  if (command.name === 'switch') {
    const found = matchTargets(args, panels);
    return result(found.length ? found.map(panel => panelRow(panel, activePanel)) : [{ note: `No panel is called “${args}”.` }]);
  }
  if (command.name === 'settings') {
    const found = matchTargets(args, pages).map(pageRow);
    if (!args) found.unshift({ title: 'Settings', sub: 'Where you left it', action: 'Open', enter: runs('settings'), tab: completes(`${PREFIX}settings `) });
    return result(found.length ? found : [{ note: `Settings has no page called “${args}”.` }]);
  }
  return result([{ title: `${PREFIX}${command.name}`, sub: command.about, action: 'Run', enter: runs(command.name), tab: completes(`${PREFIX}${command.name}`) }]);
}

/**
 * Text an extension puts in the bar (atmos.commands.open or .field, or a
 * result's `fill`): one line, at most 200 characters, a command (rev/…),
 * else just rev/. What the bar then chooses for the user is limited
 * (`fromAnotherExtension`): never another extension's command.
 */
export function textFromExtension(text) {
  const value = String(text ?? '').replace(/[\r\n]+/g, ' ').trimStart().slice(0, 200);
  return isCommand(value) ? value : PREFIX;
}

/**
 * Whether a row runs (or completes into) a command of an extension other
 * than `source`. While the bar holds part of a command name an extension
 * typed there (and, if it's destructive, in a bar an extension opened or
 * put any text in), such a row is never chosen for the user: they pick it
 * themselves.
 */
export function fromAnotherExtension(row, source) {
  const owner = row?.enter?.run?.source ?? row?.enter?.prefer?.source ?? null;
  return !!owner && owner !== source;
}

/** { name, source } when `source` declares a command called `name`, else null. */
export function ownCommand(name, source, sources = []) {
  const declares = sources.some(entry => entry.extension === source && (entry.commands || []).some(command => command.name === name));
  return declares ? { name, source } : null;
}

// ── What extensions send back (frames are not trusted) ─────────────────────

/** One line of text, at most `max` long: what a frame sends is only ever shown as text. */
function line(value, max) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** A value Atmos only hands back (never shows): kept as sent, a string at most `max` long. */
function opaque(value, max) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value.slice(0, max) : '';
}

const OPTION_ID = /^[a-z0-9_-]{1,40}$/i;

function cleanOption(option) {
  if (!option || typeof option !== 'object' || typeof option.id !== 'string' || !OPTION_ID.test(option.id) || !['select', 'toggle', 'text'].includes(option.type)) return null;
  const out = { id: option.id, type: option.type, label: line(option.label, 40) };
  if (option.type === 'toggle') out.value = option.value === true;
  else out.value = line(option.value ?? '', 200);
  if (option.type === 'select') {
    out.options = (Array.isArray(option.options) ? option.options : []).slice(0, 30)
      .map(choice => ({ value: line(choice?.value ?? '', 200), label: line(choice?.label ?? choice?.value ?? '', 60) }));
    if (!out.options.length) return null;
    out.style = option.style === 'chips' ? 'chips' : 'dropdown';
  }
  if (option.type === 'text') {
    out.prefix = line(option.prefix, 12);
    out.suffix = line(option.suffix, 40);
    out.placeholder = line(option.placeholder, 40);
  }
  return out;
}

/**
 * An extension's suggestions, as the bar may draw them: rows (at most 50)
 * of { title, sub, action, value, complete, danger }, { heading } or
 * { note }, and
 * options (at most 8) of { id, type, label, value, options, style, prefix,
 * suffix, placeholder }. Plain text throughout; anything else is dropped.
 */
export function cleanSuggestions(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.rows) ? value.rows : [];
  const rows = [];
  for (const row of list.slice(0, 50)) {
    if (!row || typeof row !== 'object') continue;
    if (typeof row.heading === 'string') { rows.push({ heading: line(row.heading, 60) }); continue; }
    if (typeof row.note === 'string') { rows.push({ note: line(row.note, 240) }); continue; }
    const title = line(row.title, 120);
    if (!title) continue;
    rows.push({
      title, sub: line(row.sub, 160), action: line(row.action, 20),
      // What comes back to run() when it's chosen: never shown, so kept as sent (a file path's spaces).
      value: row.value === undefined || row.value === null ? null : opaque(row.value, 500),
      complete: line(row.complete, 120),
      danger: row.danger === true,
    });
  }
  const options = (Array.isArray(value?.options) ? value.options : []).slice(0, 8).map(cleanOption).filter(Boolean);
  return { rows, options };
}

/** Option values: { id: text | true/false }, a few, as a frame presets them or a command's result sets them. */
export function cleanOptionValues(options) {
  const out = {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) return out;
  for (const [id, value] of Object.entries(options).slice(0, 8)) {
    if (!OPTION_ID.test(id)) continue;
    if (typeof value === 'boolean') out[id] = value;
    else if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) out[id] = String(value).slice(0, 200);
  }
  return out;
}

/**
 * What running an extension's command came back with:
 *   { done, keep, fill, options }   done: a line to show; keep: the bar stays
 *   open; fill: text for the bar (null for none); options: values to preset.
 */
export function cleanResult(value) {
  if (!value || typeof value !== 'object') return { done: '', keep: false, fill: null, options: null };
  return {
    done: line(value.done, 200),
    keep: value.keep === true,
    fill: typeof value.fill === 'string' ? value.fill.replace(/[\r\n]+/g, ' ').slice(0, 200) : null,
    options: value.options && typeof value.options === 'object' ? cleanOptionValues(value.options) : null,
  };
}
