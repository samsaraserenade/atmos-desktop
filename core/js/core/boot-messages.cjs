'use strict';
/**
 * The boot splash's lines, for the startup window (startup-splash.cjs).
 *
 * They live in core/js/boot/splash.js (BOOT_MESSAGES), which the page runs.
 * The main process reads them from there, picks one, shows it in the
 * startup window, and passes its number to the page (index.html?boot=N), so
 * the page's splash goes on with the same line and nothing changes when the
 * windows swap. One list, in one place.
 */

const fs = require('fs');

/** The string literals of `var BOOT_MESSAGES = [ … ];` in splash.js, unescaped. */
function parseBootMessages(source) {
  const start = source.indexOf('var BOOT_MESSAGES = [');
  if (start < 0) return [];
  const end = source.indexOf('];', start);
  if (end < 0) return [];
  const body = source.slice(start + 'var BOOT_MESSAGES = ['.length, end)
    .split('\n').map(line => line.replace(/^\s*\/\/.*$/, '')).join('\n'); // comment lines
  const out = [];
  const literal = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  let match;
  while ((match = literal.exec(body))) {
    const raw = match[1] !== undefined ? match[1] : match[2];
    out.push(raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escape) => (escape.length === 5 ? String.fromCharCode(parseInt(escape.slice(1), 16)) : escape)));
  }
  return out;
}

function readBootMessages(file) {
  try { return parseBootMessages(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

/** { index, text } chosen at random, or null with none. */
function pickBootMessage(messages, random = Math.random) {
  if (!messages.length) return null;
  const index = Math.floor(random() * messages.length) % messages.length;
  return { index, text: messages[index] };
}

module.exports = { parseBootMessages, readBootMessages, pickBootMessage };
