const inquirer = require("inquirer");
const path = require("path");
const fs = require("fs");
const {
  ensureVaultExists,
  listAllParked,
  loadMeta,
  saveBundle,
  pushVault,
  ensureBundlesDir,
  getBundlesDir,
  bundlePayloadPath,
} = require("../lib/vault");
const {
  walkForPicker,
  expandSelectionToFiles,
  createTarBuffer,
  sha256Buffer,
  BUNDLE_MAX_BYTES,
} = require("../lib/bundle");
const { getNextLetter } = require("../lib/files");
const {
  unwrapMEK,
  encryptBufferWithMEK,
  generateVerifier,
} = require("../lib/crypto");

function validateProjectName(name) {
  if (!name || name.trim() === "") {
    return { valid: false, error: "Project name cannot be empty." };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return {
      valid: false,
      error:
        "Project name can only contain letters, numbers, hyphens, and underscores.",
    };
  }
  if (/^[A-Z]+$/.test(name)) {
    return {
      valid: false,
      error:
        "Names cannot be all uppercase letters (reserved for IDs). Try: my-API, api-server, etc.",
    };
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return {
      valid: false,
      error: "Project name cannot contain path separators or dot-segments.",
    };
  }
  return { valid: true };
}

async function parkBundleCommand(name) {
  const nameValidation = validateProjectName(name);
  if (!nameValidation.valid) {
    console.error(nameValidation.error);
    return;
  }

  try {
    await ensureVaultExists();
  } catch (err) {
    if (err.message.startsWith("VAULT_PULL_FAILED:")) {
      console.error(
        "Could not reach vault. Check your internet connection and try again.",
      );
    } else {
      console.error("Vault error:", err.message);
    }
    return;
  }

  const allParked = listAllParked();
  if (allParked.some((p) => p.name === name)) {
    console.error(
      'Name "' +
        name +
        '" is already in use by another parked entry. Choose another name.',
    );
    return;
  }

  const { rootInput } = await inquirer.prompt([
    {
      type: "input",
      name: "rootInput",
      message: "Folder to park files from (absolute or relative path):",
      default: process.cwd(),
    },
  ]);

  const bundleRoot = path.resolve(process.cwd(), rootInput.trim());
  if (!fs.existsSync(bundleRoot) || !fs.statSync(bundleRoot).isDirectory()) {
    console.error("Not a directory or path does not exist:", bundleRoot);
    return;
  }

  const entries = walkForPicker(bundleRoot);
  if (entries.length === 0) {
    console.error("No files found under that folder.");
    return;
  }

  const choices = entries.map((e) => ({
    name: e.label + (e.isDir ? " (folder)" : ""),
    value: e.rel.split(path.sep).join("/"),
  }));

  const { selected } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "selected",
      message:
        "Select files and/or folders to include (space to toggle, enter when done):",
      choices,
      validate: (ans) =>
        ans && ans.length > 0 ? true : "Select at least one item.",
    },
  ]);

  if (!selected || selected.length === 0) {
    console.log("Cancelled.");
    return;
  }

  let files;
  let totalBytes;
  try {
    const expanded = expandSelectionToFiles(bundleRoot, selected);
    files = expanded.files;
    totalBytes = expanded.totalBytes;
  } catch (err) {
    console.error(err.message);
    return;
  }

  let tarBuffer;
  try {
    tarBuffer = createTarBuffer(bundleRoot, files);
  } catch (err) {
    console.error(err.message);
    return;
  }

  if (tarBuffer.length > BUNDLE_MAX_BYTES + 2 * 1024 * 1024) {
    console.error(
      "Archive is too large (over " +
        Math.floor(BUNDLE_MAX_BYTES / (1024 * 1024)) +
        " MiB after packing).",
    );
    return;
  }

  const { masterPassword } = await inquirer.prompt([
    {
      type: "password",
      name: "masterPassword",
      message: "Master password:",
      mask: "*",
    },
  ]);

  const meta = loadMeta();
  let mek;
  try {
    mek = unwrapMEK(meta.mek_wrapped_password, masterPassword);
  } catch (err) {
    console.error("Incorrect master password.");
    return;
  }

  const computedVerifier = generateVerifier(mek);
  if (computedVerifier !== meta.verifier) {
    console.error("Incorrect master password.");
    return;
  }

  let encryptedPayload;
  try {
    encryptedPayload = encryptBufferWithMEK(tarBuffer, mek);
  } catch (err) {
    console.error("Encryption failed:", err.message);
    return;
  }

  const payloadShaBefore = sha256Buffer(encryptedPayload);
  const metaIds = meta.retiredIds || [];
  const activeIds = listAllParked().map((p) => p.id);
  const allUsedIds = [...metaIds, ...activeIds];
  const id = getNextLetter(allUsedIds);

  ensureBundlesDir();
  const bundleDir = path.join(getBundlesDir(), id);
  if (fs.existsSync(bundleDir)) {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
  fs.mkdirSync(bundleDir, { recursive: true });

  const payloadPath = bundlePayloadPath(id);
  fs.writeFileSync(payloadPath, encryptedPayload);

  const parkedPaths = selected.map((p) => p.split(path.sep).join("/"));
  const manifest = {
    kind: "bundle",
    id,
    name,
    parked_at: new Date().toISOString(),
    bundle_root: bundleRoot,
    parked_paths: parkedPaths,
    file_count: files.length,
    plaintext_bytes: totalBytes,
    archive_bytes: tarBuffer.length,
    payload_size: encryptedPayload.length,
    payload_sha256: payloadShaBefore,
    removed_local: false,
  };

  saveBundle(id, manifest);

  const pushOk = await pushVault("park: add files bundle " + name);
  if (!pushOk) {
    console.error(
      "Vault push failed. Local files are unchanged. Fix connection and try again.",
    );
    try {
      fs.unlinkSync(path.join(getBundlesDir(), id + ".json"));
      fs.rmSync(bundleDir, { recursive: true, force: true });
    } catch (e) {
      /* best effort cleanup */
    }
    return;
  }

  async function verifyVaultPayload() {
    const jsonPath = path.join(getBundlesDir(), id + ".json");
    if (!fs.existsSync(jsonPath) || !fs.existsSync(payloadPath)) {
      return { ok: false, reason: "Bundle manifest or payload missing in vault." };
    }
    let diskHash;
    try {
      diskHash = sha256Buffer(fs.readFileSync(payloadPath));
    } catch (e) {
      return { ok: false, reason: "Could not read payload from vault." };
    }
    if (diskHash !== payloadShaBefore) {
      return {
        ok: false,
        reason: "Payload checksum mismatch after push (vault copy differs).",
      };
    }
    return { ok: true };
  }

  const verify = await verifyVaultPayload();
  if (!verify.ok) {
    console.error("Verification failed: " + verify.reason);
    console.error(
      "Your data was pushed but local verification failed. Do not delete originals until you confirm the vault on another machine.",
    );
    return;
  }

  const { removeLocal } = await inquirer.prompt([
    {
      type: "list",
      name: "removeLocal",
      message:
        "Remove the parked files and folders from this machine? (Vault already has an encrypted copy.)",
      choices: [
        { name: "No — keep local files", value: "keep" },
        { name: "Yes — delete only the paths I selected", value: "delete" },
      ],
    },
  ]);

  if (removeLocal === "keep") {
    console.log(
      "\n\x1b[32m✓ Parked as [" +
        id +
        "]. Local files kept. Use `parking unpark " +
        id +
        "` to restore elsewhere.\x1b[0m",
    );
    return;
  }

  const verify2 = await verifyVaultPayload();
  if (!verify2.ok) {
    console.error("Pre-delete verification failed: " + verify2.reason);
    console.error("Skipping local delete.");
    return;
  }

  const rootResolved = path.resolve(bundleRoot);
  for (const rel of parkedPaths) {
    const full = path.resolve(bundleRoot, rel);
    if (
      full !== rootResolved &&
      !full.startsWith(rootResolved + path.sep)
    ) {
      console.error("Skip unsafe path:", rel);
      continue;
    }
    try {
      if (fs.existsSync(full)) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch (err) {
      console.error("Could not delete " + rel + ": " + err.message);
    }
  }

  const updated = {
    ...manifest,
    removed_local: true,
  };
  saveBundle(id, updated);
  const push2 = await pushVault("park: bundle " + name + " removed_local");
  if (!push2) {
    console.log(
      "\x1b[33m⚠ Local paths were deleted but updating the vault manifest failed. Run parking when online to sync, or restore from backup.\x1b[0m",
    );
  }

  console.log(
    "\n\x1b[32m✓ Parked as [" +
      id +
      "]. Selected paths were removed locally. Use `parking unpark " +
      id +
      "` to restore.\x1b[0m",
  );
}

module.exports = { parkBundleCommand, validateProjectName };
