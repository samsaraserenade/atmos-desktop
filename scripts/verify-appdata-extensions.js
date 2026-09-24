const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appData = process.platform === 'win32'
  ? process.env.APPDATA
  : process.env.XDG_CONFIG_HOME || path.join(require('os').homedir(), '.config');
const roots = [path.join(appData, 'atmos', 'plugins'), path.join(appData, 'atmos', 'services')];
const files = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'node_modules') continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
  }
}
roots.forEach(walk);

const failures = [];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  try { new vm.SourceTextModule(source, { identifier: file }); }
  catch (error) { failures.push(`${file}: ${error.message}`); continue; }
  const importsOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const match of importsOnly.matchAll(/(?:from\s*|import\s*\()(['"])(\.\.?\/[^'"]+)\1/g)) {
    const resolved = path.resolve(path.dirname(file), match[2]);
    if (!fs.existsSync(resolved)) failures.push(`${file}: missing ${match[2]}`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Checked ${files.length} extension modules and their relative imports.`);
