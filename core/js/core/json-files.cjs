'use strict';
/** Small JSON files in user data: read with a fallback, write atomically. */
const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** A temporary file renamed over the old one, so a crash leaves the previous copy. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

module.exports = { readJson, writeJson };
