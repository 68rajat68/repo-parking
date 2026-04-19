const fs = require('fs');
const path = require('path');

function validateRelativePath(relPath, projectRoot) {
  // Reject obvious escape patterns first
  if (relPath.startsWith('/')) {
    throw new Error('Path must be relative');
  }
  if (relPath.includes('..')) {
    throw new Error('Path cannot contain ".." segments');
  }

  // CRITICAL PATH SAFETY: use path.resolve for robust validation
  const resolved = path.resolve(projectRoot, relPath);

  // SYMLINK RESOLUTION: walk from projectRoot, not from relPath
  let checked = projectRoot;
  const segments = relPath.split(path.sep);

  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    const candidate = path.join(checked, segment);
    if (!fs.existsSync(candidate)) {
      break;
    }
    const stats = fs.lstatSync(candidate);
    if (stats.isSymbolicLink()) {
      throw new Error('Symlinks not allowed in extra file paths');
    }
    checked = candidate;
  }

  // Final validation
  if (resolved === projectRoot) {
    throw new Error('Path resolves to repo root');
  }
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relPath)) {
    throw new Error('Path escapes root');
  }

  return resolved;
}

function encodeFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  return buffer.toString('base64');
}

function decodeAndWriteFile(base64Data, relPath, projectRoot) {
  const resolvedPath = validateRelativePath(relPath, projectRoot);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolvedPath, Buffer.from(base64Data, 'base64'));
}

function validateFileSizes(relPaths, repoRoot) {
  const warn = [];
  const error = [];

  for (const relPath of relPaths) {
    const fullPath = path.join(repoRoot, relPath);
    if (!fs.existsSync(fullPath)) {
      continue;
    }

    const stats = fs.statSync(fullPath);
    const size = stats.size;

    if (size > 1048576) {
      error.push(relPath + ' (' + Math.round(size / 1048576 * 10) / 10 + 'MB)');
    } else if (size > 512000) {
      warn.push(relPath + ' (' + Math.round(size / 1024) + 'KB)');
    }
  }

  return { warn, error };
}

function toExcelColumn(n) {
  let result = '';
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

function getNextLetter(usedIds) {
  const used = new Set(usedIds);
  let n = 1;
  while (true) {
    const candidate = toExcelColumn(n);
    if (!used.has(candidate)) {
      return candidate;
    }
    n++;
  }
}

module.exports = {
  validateRelativePath,
  encodeFile,
  decodeAndWriteFile,
  validateFileSizes,
  getNextLetter
};
