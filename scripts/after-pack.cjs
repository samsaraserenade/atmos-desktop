'use strict';
/**
 * electron-builder afterPack hook: record a SHA-256 hash of every bundled
 * extension file in resources/extensions/integrity.json. At startup Core
 * refuses to load a bundled extension whose files no longer match (see
 * core/js/core/extension-trust.cjs).
 *
 * This makes changes to an installed copy of Atmos visible; it does not
 * stop someone who can also rewrite integrity.json. That needs a signed
 * installer and app, which is planned separately.
 */
const fs = require('fs');
const path = require('path');
const { writeIntegrityList } = require('../core/js/core/extension-integrity.cjs');

/**
 * Keep only the released extensions (release.json) in a packed build, so an
 * installer carries what is released and nothing else. Resolves the ids removed.
 */
function pruneUnreleased(extensionsRoot, release = readRelease()) {
  const removed = [];
  for (const kind of ['plugins', 'services']) {
    const keep = new Set(release[kind] || []);
    const dir = path.join(extensionsRoot, kind);
    if (!fs.existsSync(dir)) continue;
    for (const id of fs.readdirSync(dir)) {
      if (keep.has(id)) continue;
      fs.rmSync(path.join(dir, id), { recursive: true, force: true });
      removed.push(`${kind}/${id}`);
    }
    for (const id of keep) {
      if (!fs.existsSync(path.join(dir, id, 'extension.json'))) throw new Error(`after-pack: release.json lists ${kind}/${id}, which is not in the build`);
    }
  }
  return removed;
}

function readRelease() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'release.json'), 'utf8'));
}

module.exports = async function afterPack(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const extensionsRoot = path.join(resources, 'extensions');
  if (!fs.existsSync(extensionsRoot)) throw new Error(`after-pack: ${extensionsRoot} is missing`);
  // `npm run build:personal` (scripts/build-personal.cjs) keeps every
  // extension in the checkout, for your own everyday install.
  if (process.env.ATMOS_BUILD_ALL === '1') {
    console.log('  • personal build: every extension kept (release.json not applied)');
  } else {
    const removed = pruneUnreleased(extensionsRoot);
    if (removed.length) console.log(`  • not released (release.json), left out: ${removed.join(', ')}`);
  }
  const list = writeIntegrityList(extensionsRoot);
  const files = Object.values(list.extensions).reduce((sum, entries) => sum + Object.keys(entries).length, 0);
  console.log(`  • integrity.json: ${Object.keys(list.extensions).length} extensions, ${files} files`);
};

module.exports.pruneUnreleased = pruneUnreleased;

// `node scripts/after-pack.cjs <resources/extensions>` rewrites the list by hand.
if (require.main === module) {
  const root = process.argv[2];
  if (!root) { console.error('usage: node scripts/after-pack.cjs <extensions root>'); process.exit(1); }
  writeIntegrityList(path.resolve(root));
  console.log(`wrote ${path.join(root, 'integrity.json')}`);
}
