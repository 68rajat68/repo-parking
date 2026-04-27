const inquirer = require("inquirer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  ensureVaultExists,
  loadProject,
  deleteProject,
  deleteBundle,
  loadMeta,
  saveMeta,
  pushVault,
  vaultPath,
  isBundleEntry,
} = require("../lib/vault");

async function forgetCommand(nameOrLetter) {
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

  const project = loadProject(nameOrLetter);

  if (!project) {
    console.error("Project not found:", nameOrLetter);
    console.log("");
    console.log("Run \x1b[36mparking list\x1b[0m to see all parked entries.");
    return;
  }

  const bundle = isBundleEntry(project);

  console.log("");
  console.log(bundle ? "Bundle to forget:" : "Project to forget:");
  console.log("  Letter: " + project.id);
  console.log("  Name:   " + project.name);
  if (!bundle) {
    console.log("  Remote: " + project.remote);
  }
  console.log("");
  console.log(
    bundle
      ? "This removes the encrypted files from your vault only."
      : "This does NOT delete your GitHub repo. Only removes the vault entry.",
  );
  console.log(
    "\x1b[33m⚠ If you have not unparked recently, you will lose access to this data.\x1b[0m",
  );

  const { confirmName } = await inquirer.prompt([
    {
      type: "input",
      name: "confirmName",
      message: 'Type "' + project.name + '" to confirm:',
      validate: (input) => {
        if (input !== project.name) {
          return "Cancelled.";
        }
        return true;
      },
    },
  ]);

  if (confirmName !== project.name) {
    console.log("Cancelled.");
    return;
  }

  const entryPath = bundle
    ? path.join(vaultPath, "bundles", project.id + ".json")
    : path.join(vaultPath, "projects", project.id + ".json");

  let entryBackup = null;
  let bundlePayloadBackupDir = null;

  try {
    if (fs.existsSync(entryPath)) {
      entryBackup = fs.readFileSync(entryPath, "utf8");
    }
    if (bundle) {
      const bundleDataDir = path.join(vaultPath, "bundles", project.id);
      if (fs.existsSync(bundleDataDir)) {
        bundlePayloadBackupDir = path.join(
          os.tmpdir(),
          "parking-forget-" + project.id + "-" + Date.now(),
        );
        fs.cpSync(bundleDataDir, bundlePayloadBackupDir, { recursive: true });
      }
    }
  } catch (err) {
    entryBackup = null;
    bundlePayloadBackupDir = null;
  }

  const originalMeta = loadMeta();

  if (bundle) {
    deleteBundle(project.id);
  } else {
    deleteProject(project.id);
  }
  const newMeta = { ...originalMeta, retiredIds: [...(originalMeta.retiredIds || []), project.id] };
  saveMeta(newMeta);

  const success = await pushVault(
    (bundle ? "forget: remove bundle " : "forget: remove project ") +
      project.name,
  );

  if (!success) {
    if (entryBackup) {
      fs.writeFileSync(entryPath, entryBackup);
    }
    if (bundle && bundlePayloadBackupDir) {
      const restoreDir = path.join(vaultPath, "bundles", project.id);
      try {
        fs.mkdirSync(path.dirname(restoreDir), { recursive: true });
        fs.cpSync(bundlePayloadBackupDir, restoreDir, { recursive: true });
      } catch (e) {
        /* best effort */
      }
      try {
        fs.rmSync(bundlePayloadBackupDir, { recursive: true, force: true });
      } catch (e) {
        /* ignore */
      }
    }
    saveMeta(originalMeta);
    console.log(
      "Could not reach vault. No changes were made. Try again when online.",
    );
    return;
  }

  if (bundlePayloadBackupDir) {
    try {
      fs.rmSync(bundlePayloadBackupDir, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  }

  console.log(
    "Forgotten. Letter [" +
      project.id +
      "] is retired and will never be reused.",
  );
}

module.exports = forgetCommand;
