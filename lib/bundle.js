const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const BUNDLE_MAX_BYTES = 100 * 1024 * 1024;
const MAX_WALK_DEPTH = 40;
const MAX_FILES = 20000;

function validateBundleRelativePath(relPath, rootAbs) {
  if (!relPath || relPath.startsWith("/") || path.isAbsolute(relPath)) {
    throw new Error("Path must be relative");
  }
  if (relPath.includes("..")) {
    throw new Error('Path cannot contain ".."');
  }
  const resolved = path.resolve(rootAbs, relPath);
  const rel = path.relative(rootAbs, resolved);
  if (rel.startsWith("..") || rel === "") {
    throw new Error("Path escapes root");
  }
  let checked = rootAbs;
  const segments = relPath.split(path.sep);
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    const candidate = path.join(checked, segment);
    if (!fs.existsSync(candidate)) break;
    const st = fs.lstatSync(candidate);
    if (st.isSymbolicLink()) {
      throw new Error("Symlinks not allowed: " + relPath);
    }
    checked = candidate;
  }
  return resolved;
}

function walkForPicker(rootAbs, relBase = "", depth = 0, out = []) {
  if (depth > MAX_WALK_DEPTH) return out;
  const dirAbs = relBase ? path.join(rootAbs, relBase) : rootAbs;
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    const name = ent.name;
    const rel = relBase ? path.join(relBase, name) : name;
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      out.push({ rel, isDir: true, label: rel + path.sep });
      walkForPicker(rootAbs, rel, depth + 1, out);
    } else if (ent.isFile()) {
      out.push({ rel, isDir: false, label: rel });
    }
  }
  return out;
}

function expandSelectionToFiles(rootAbs, selectedRels) {
  const files = new Set();
  let totalBytes = 0;

  for (const rel of selectedRels) {
    const full = validateBundleRelativePath(rel, rootAbs);
    const st = fs.statSync(full);
    if (st.isFile()) {
      if (files.size >= MAX_FILES) {
        throw new Error("Too many files (max " + MAX_FILES + ")");
      }
      files.add(rel.split(path.sep).join("/"));
      totalBytes += st.size;
      if (totalBytes > BUNDLE_MAX_BYTES) {
        throw new Error(
          "Selection exceeds " +
            Math.floor(BUNDLE_MAX_BYTES / (1024 * 1024)) +
            " MiB",
        );
      }
    } else if (st.isDirectory()) {
      function walkDir(relDir) {
        const abs = path.join(rootAbs, relDir);
        const ents = fs.readdirSync(abs, { withFileTypes: true });
        for (const ent of ents) {
          const subRel = path.join(relDir, ent.name).split(path.sep).join("/");
          if (ent.isSymbolicLink()) continue;
          const p = path.join(abs, ent.name);
          if (ent.isDirectory()) {
            walkDir(subRel);
          } else if (ent.isFile()) {
            if (files.size >= MAX_FILES) {
              throw new Error("Too many files (max " + MAX_FILES + ")");
            }
            const s = fs.statSync(p);
            files.add(subRel);
            totalBytes += s.size;
            if (totalBytes > BUNDLE_MAX_BYTES) {
              throw new Error(
                "Selection exceeds " +
                  Math.floor(BUNDLE_MAX_BYTES / (1024 * 1024)) +
                  " MiB",
              );
            }
          }
        }
      }
      walkDir(rel.split(path.sep).join("/"));
    }
  }

  return { files: [...files].sort(), totalBytes };
}

function createTarBuffer(rootAbs, fileRelsSorted) {
  if (fileRelsSorted.length === 0) {
    throw new Error("No files to archive");
  }
  const maxOut = BUNDLE_MAX_BYTES + 5 * 1024 * 1024;
  const r = spawnSync("tar", ["-cf", "-", ...fileRelsSorted], {
    cwd: rootAbs,
    maxBuffer: maxOut,
    encoding: "buffer",
  });
  if (r.error) {
    throw new Error("tar failed to start: " + r.error.message);
  }
  if (r.status !== 0) {
    const err = r.stderr ? r.stderr.toString() : "unknown error";
    throw new Error("tar failed: " + err);
  }
  if (!r.stdout || r.stdout.length > maxOut) {
    throw new Error("Archive too large");
  }
  return r.stdout;
}

function extractTarBuffer(tarBuffer, destAbs) {
  fs.mkdirSync(destAbs, { recursive: true });
  const maxBuf = BUNDLE_MAX_BYTES + 5 * 1024 * 1024;
  const r = spawnSync("tar", ["-xf", "-", "-C", destAbs], {
    input: tarBuffer,
    maxBuffer: maxBuf,
    encoding: "buffer",
  });
  if (r.status !== 0) {
    const err = r.stderr ? r.stderr.toString() : "unknown error";
    throw new Error("tar extract failed: " + err);
  }
}

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

module.exports = {
  BUNDLE_MAX_BYTES,
  MAX_FILES,
  validateBundleRelativePath,
  walkForPicker,
  expandSelectionToFiles,
  createTarBuffer,
  extractTarBuffer,
  sha256Buffer,
};
