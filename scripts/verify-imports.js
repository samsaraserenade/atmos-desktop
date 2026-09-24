/**
 * verify-imports.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Standalone diagnostic — not part of the app, doesn't touch app.js/index.html.
 *
 * Walks every .js file in the project, finds every `import ... from '...'`
 * (static and dynamic), resolves each relative path, and reports any that
 * point to a file that doesn't actually exist on disk.
 *
 * Run from the project root:
 *   node verify-imports.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'scripts']);

// Matches: import ... from '...'   and   import('...')
const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.html')) files.push(full);
  }
  return files;
}

function checkFile(filePath, problems) {
  const source = fs.readFileSync(filePath, 'utf8');
  // Import-looking examples in documentation comments are not executable
  // dependencies and should not be reported as broken paths.
  const content = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const dir = path.dirname(filePath);
  let match;

  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(content)) !== null) {
    const spec = match[1];

    // Skip bare package imports (no relative/absolute path) — those are
    // node_modules or CDN imports, not local files.
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;

    const resolved = path.resolve(dir, spec);

    if (!fs.existsSync(resolved)) {
      const lineNum = content.slice(0, match.index).split('\n').length;
      problems.push({
        file: path.relative(ROOT, filePath),
        line: lineNum,
        spec,
        resolved: path.relative(ROOT, resolved),
      });
    }
  }
}

const allFiles = walk(ROOT);
const problems = [];

for (const f of allFiles) {
  try {
    checkFile(f, problems);
  } catch (err) {
    console.log(`[skip] couldn't read ${path.relative(ROOT, f)}: ${err.message}`);
  }
}

console.log(`\nScanned ${allFiles.length} files.\n`);

if (!problems.length) {
  console.log('✅ No broken import paths found.');
} else {
  console.log(`❌ Found ${problems.length} broken import${problems.length > 1 ? 's' : ''}:\n`);
  for (const p of problems) {
    console.log(`  ${p.file}:${p.line}`);
    console.log(`    imports "${p.spec}"`);
    console.log(`    → resolves to missing file: ${p.resolved}\n`);
  }
}
