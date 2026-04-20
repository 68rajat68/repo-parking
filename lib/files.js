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

async function getGitignoreFiles(repoRoot) {
  const files = [];
  const warnings = [];

  function globToRegex(pattern) {
    let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    escaped = escaped.replace(/\*/g, '.*');
    escaped = escaped.replace(/\?/g, '.');
    return new RegExp('^' + escaped + '$');
  }

  try {
    // STEP A — Read .gitignore
    const gitignorePath = path.join(repoRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      return { files: [], warnings: [] };
    }

    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
    const patterns = gitignoreContent.split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
      .filter(line => !line.startsWith('#'))
      .filter(line => !line.startsWith('!'));

    // STEP B — Expand patterns to actual files
    for (const pattern of patterns) {
      // CASE 1 — Exact file path (no wildcards, no trailing slash)
      if (!pattern.includes('*') && !pattern.includes('?') && !pattern.includes('[') && !pattern.endsWith('/')) {
        const candidatePath = path.join(repoRoot, pattern);
        if (fs.existsSync(candidatePath)) {
          try {
            const stats = fs.statSync(candidatePath);
            if (stats.isFile()) {
              if (stats.size > 1048576) {
                // Skip files > 1MB silently
              } else if (stats.size > 512000) {
                warnings.push(pattern);
                files.push(pattern);
              } else {
                files.push(pattern);
              }
            }
          } catch (e) {
            // Skip on error
          }
        }
        continue;
      }

      // CASE 2 — Directory pattern (ends with '/')
      if (pattern.endsWith('/')) {
        continue; // Skip directories
      }

      // CASE 3 — Filename-only wildcard (no path separator, has wildcard)
      if (!pattern.includes('/') && (pattern.includes('*') || pattern.includes('?'))) {
        try {
          const entries = fs.readdirSync(repoRoot);
          const regex = globToRegex(pattern);
          for (const entry of entries) {
            const entryPath = path.join(repoRoot, entry);
            try {
              const stats = fs.statSync(entryPath);
              if (stats.isFile() && regex.test(entry)) {
                if (stats.size > 1048576) {
                  // Skip > 1MB silently
                } else if (stats.size > 512000) {
                  warnings.push(entry);
                  if (!files.includes(entry)) files.push(entry);
                } else {
                  if (!files.includes(entry)) files.push(entry);
                }
              }
            } catch (e) {
              // Skip
            }
          }
        } catch (e) {
          // Skip on error
        }
        continue;
      }

      // CASE 4 — Path wildcard (contains '/' AND wildcard)
      // Skip silently — too complex without glob library
    }

    // STEP C — Deduplicate and sort
    const uniqueFiles = [...new Set(files)];

    // Sort: .env and .env.* first, then alphabetical
    uniqueFiles.sort((a, b) => {
      const aIsEnv = a === '.env' || a.startsWith('.env.');
      const bIsEnv = b === '.env' || b.startsWith('.env.');
      if (aIsEnv && !bIsEnv) return -1;
      if (!aIsEnv && bIsEnv) return 1;
      return a.localeCompare(b);
    });

    return { files: uniqueFiles, warnings };
  } catch (err) {
    // Never throw — return empty on any error
    return { files: [], warnings: [] };
  }
}

module.exports = {
  validateRelativePath,
  encodeFile,
  decodeAndWriteFile,
  validateFileSizes,
  getNextLetter,
  getGitignoreFiles
};
