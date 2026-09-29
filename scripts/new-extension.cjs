#!/usr/bin/env node
'use strict';
/**
 * Start a new Atmos extension from the template (templates/extension).
 *
 *   npm run new:extension -- <folder> [--name "Display Name"] [--publisher you]
 *   npm run new:extension -- <folder> --update-sdk
 *
 * The folder's name is the extension's id (lowercase letters, numbers and
 * hyphens). It gets a panel, a sidebar widget, tests and, in .atmos-sdk/,
 * what an editor and the tests need from Atmos: the SDK's typings, the
 * manifest's JSON schema and the fake Atmos for tests (all MIT). With
 * --update-sdk, only .atmos-sdk/ is refreshed, from this copy of Atmos.
 */
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const TEMPLATE = path.join(repo, 'templates', 'extension');
const SDK = path.join(repo, 'core', 'js', 'sdk');
const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;

/** What an extension's .atmos-sdk/ holds, from Atmos's core/js/sdk. */
const SDK_FILES = [
  'atmos-sdk.d.ts',
  'extension.schema.json',
  'LICENSE',
  'testing/fake-atmos.mjs',
  'testing/register.mjs',
  'testing/resolve.mjs',
  'testing/sdk.mjs',
];

function titleCase(id) {
  return id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** Copy the SDK's development files into <dir>/.atmos-sdk. */
function writeSdk(dir, atmosVersion) {
  const target = path.join(dir, '.atmos-sdk');
  fs.rmSync(target, { recursive: true, force: true });
  for (const file of SDK_FILES) {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.copyFileSync(path.join(SDK, file), path.join(target, file));
  }
  fs.writeFileSync(path.join(target, 'README.md'), [
    `# Atmos SDK ${sdkVersion()}, for development`,
    '',
    `Copied from Atmos ${atmosVersion}. Atmos gives your frames the SDK itself;`,
    'these are only for your editor and your tests, and are never served to a',
    'frame (Atmos serves no folder whose name starts with a dot).',
    '',
    '- `atmos-sdk.d.ts`: the SDK\'s types (`jsconfig.json` points `atmos-sdk` here).',
    '- `extension.schema.json`: the manifest\'s JSON schema (`"$schema"` in `extension.json`).',
    '- `testing/`: a fake Atmos for Node tests (`fake-atmos.mjs`), and',
    '  `register.mjs`, which makes `import atmos from \'atmos-sdk\'` give it.',
    '',
    'Refresh from a newer Atmos: `npm run new:extension -- <this folder> --update-sdk`',
    'in the Atmos repository.',
    '',
  ].join('\n'));
}

function sdkVersion() {
  return fs.readFileSync(path.join(SDK, 'atmos-sdk.js'), 'utf8').match(/export const SDK_VERSION = '([^']+)'/)[1];
}

/** Every file of the template, relative. */
function templateFiles(dir = TEMPLATE, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) templateFiles(full, out);
    else out.push(path.relative(TEMPLATE, full));
  }
  return out.sort();
}

/**
 * Make a new extension in `dir` from the template. Returns its id and the
 * files written.
 */
function createExtension(dir, { name = null, publisher = null } = {}) {
  const folder = path.resolve(dir);
  const id = path.basename(folder);
  if (!VALID_ID.test(id)) throw new Error(`the folder's name is the extension's id: use lowercase letters, numbers and hyphens ('${id}')`);
  if (fs.existsSync(folder) && fs.readdirSync(folder).length) throw new Error(`${folder} isn't empty`);
  const atmosVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
  const displayName = (name || titleCase(id)).trim().slice(0, 60);
  const values = { id, name: displayName, publisher: publisher || 'me', atmos: atmosVersion, path: folder };
  // Each file type gets the values escaped for where they land.
  const escape = {
    '.json': value => JSON.stringify(value).slice(1, -1),
    '.js': value => value.replace(/[\\'`$]/g, character => `\\${character}`).replace(/[<>]/g, ''),
  };
  const written = [];
  for (const rel of templateFiles()) {
    const text = fs.readFileSync(path.join(TEMPLATE, rel), 'utf8');
    const esc = escape[path.extname(rel)] || (value => value);
    const out = text.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in values ? esc(String(values[key])) : match));
    fs.mkdirSync(path.dirname(path.join(folder, rel)), { recursive: true });
    fs.writeFileSync(path.join(folder, rel), out);
    written.push(rel);
  }
  writeSdk(folder, atmosVersion);
  return { id, folder, files: written };
}

function main() {
  const args = process.argv.slice(2);
  const option = flag => { const i = args.indexOf(flag); return i === -1 ? null : args.splice(i, 2)[1]; };
  const updateSdk = args.includes('--update-sdk') ? (args.splice(args.indexOf('--update-sdk'), 1), true) : false;
  const name = option('--name');
  const publisher = option('--publisher');
  const dir = args[0];
  if (!dir) {
    console.error('usage: npm run new:extension -- <folder> [--name "Display Name"] [--publisher you] | <folder> --update-sdk');
    process.exit(1);
  }
  try {
    if (updateSdk) {
      if (!fs.existsSync(path.join(dir, 'extension.json'))) throw new Error(`${path.resolve(dir)} has no extension.json`);
      writeSdk(path.resolve(dir), JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version);
      console.log(`updated ${path.join(path.resolve(dir), '.atmos-sdk')} to SDK ${sdkVersion()}`);
      return;
    }
    const { id, folder } = createExtension(dir, { name, publisher });
    console.log(`made '${id}' in ${folder}

Next:
  cd "${folder}" && npm test             # its tests, in Node
  npm start -- --dev-extension="${folder}"   # from this repo: Atmos with it loaded (quit Atmos first)

Its README says more.`);
  } catch (error) {
    console.error(`new-extension: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { createExtension, writeSdk, SDK_FILES };
