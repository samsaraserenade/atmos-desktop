'use strict';

const fs = require('fs');
const path = require('path');

const VALID_KINDS = new Set(['plugin', 'service']);
const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Core-owned enablement state. This intentionally lives outside renderer
 * localStorage so the main process can make the decision before requiring an
 * extension's privileged entry point.
 */
function createExtensionPreferences(filePath) {
  function read() {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return value && typeof value === 'object' ? value : {};
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[extensions] failed to read enablement state:', error.message);
      return {};
    }
  }

  function isEnabled(kind, id) {
    if (!VALID_KINDS.has(kind) || !VALID_ID.test(id)) return false;
    return read()?.[kind]?.[id] !== false;
  }

  function disabledIds(kind) {
    if (!VALID_KINDS.has(kind)) return new Set();
    const entries = read()?.[kind];
    if (!entries || typeof entries !== 'object') return new Set();
    return new Set(Object.entries(entries)
      .filter(([id, enabled]) => VALID_ID.test(id) && enabled === false)
      .map(([id]) => id));
  }

  function setEnabled(kind, id, enabled) {
    if (!VALID_KINDS.has(kind) || !VALID_ID.test(id) || typeof enabled !== 'boolean') {
      throw new Error('Invalid extension enablement request');
    }

    const state = read();
    state[kind] = state[kind] && typeof state[kind] === 'object' ? state[kind] : {};
    if (enabled) delete state[kind][id];
    else state[kind][id] = false;

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2));
    fs.renameSync(temporaryPath, filePath);
    return enabled;
  }

  return { disabledIds, isEnabled, setEnabled };
}

module.exports = { createExtensionPreferences };
