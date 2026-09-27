'use strict';
/**
 * Each extension's `atmos.state`, in a file of its own:
 * userData/extension-state/<kind>-<id>.json.
 *
 * Until Atmos 0.12 every extension's state was one namespace in the Atmos
 * page's single saved blob, rewritten whole on each change: one extension's
 * save rewrote everyone's, and they shared one browser storage quota. Now
 * each is written on its own, atomically (a temporary file, flushed, then
 * renamed over the old one), and removing an extension with its data
 * deletes its file. The page keeps the working copy and sends changes here
 * (extension-frame-host.js); the first time an extension's state is used,
 * the page copies it from the old blob, and forgets the blob's copy at a
 * later start, once this file exists.
 */

const fs = require('fs');
const path = require('path');

const MAX_STATE_BYTES = 1024 * 1024;
const VALID = /^(plugin|service)$/;
const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;

function createExtensionStateStore({ dir, warn = message => console.warn(message) }) {
  const fileOf = (kind, id) => {
    if (!VALID.test(kind) || !VALID_ID.test(id)) throw new TypeError(`not an extension: ${kind}:${id}`);
    return path.join(dir, `${kind}-${id}.json`);
  };

  /** Every saved state: { "plugin:<id>": data }. Unreadable files are set aside, not lost. */
  function loadAll() {
    const out = {};
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const name of names) {
      const match = name.match(/^(plugin|service)-([a-z0-9][a-z0-9-]*)\.json$/);
      if (!match) continue;
      const file = path.join(dir, name);
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved?.format !== 1 || !saved.data || typeof saved.data !== 'object' || Array.isArray(saved.data)) throw new Error('unsupported format');
        out[`${match[1]}:${match[2]}`] = saved.data;
      } catch (error) {
        const aside = `${file}.unreadable-${Date.now()}`;
        warn(`[extensions] ${name} is unreadable (${error.message}); kept as ${path.basename(aside)}`);
        try { fs.renameSync(file, aside); } catch { /* leave it */ }
      }
    }
    return out;
  }

  /** Replace kind:id's state. Refuses anything but a plain JSON object of at most 1 MB. */
  function save(kind, id, data) {
    const file = fileOf(kind, id);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('state must be an object');
    // The same limit the SDK's bridge applies (the data's JSON length).
    if (JSON.stringify(data).length > MAX_STATE_BYTES) throw new RangeError('state is larger than 1 MB');
    const json = JSON.stringify({ format: 1, kind, id, data });
    fs.mkdirSync(dir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    const handle = fs.openSync(temporary, 'w');
    try {
      fs.writeFileSync(handle, json);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, file);
  }

  function remove(kind, id) {
    fs.rmSync(fileOf(kind, id), { force: true });
  }

  function has(kind, id) {
    return fs.existsSync(fileOf(kind, id));
  }

  return { loadAll, save, remove, has, dir };
}

module.exports = { createExtensionStateStore, MAX_STATE_BYTES };
