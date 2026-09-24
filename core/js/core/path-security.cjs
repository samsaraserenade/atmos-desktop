const path = require('path');

function resolveContainedPath(root, requestedPath) {
  const resolvedRoot = path.resolve(root);
  const relativeInput = String(requestedPath).replace(/^[/\\]+/, '');
  const candidate = path.resolve(resolvedRoot, relativeInput);
  const relative = path.relative(resolvedRoot, candidate);
  const escaped = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return escaped ? null : candidate;
}

module.exports = { resolveContainedPath };
