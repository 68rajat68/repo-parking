const inquirer = require("inquirer");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const simpleGit = require("simple-git");
const { ensureVaultExists, loadProject, loadMeta } = require("../lib/vault");
const { cloneRepo } = require("../lib/git");
const { parseSshConfig, addSshKey } = require("../lib/ssh");
const { writeEnvFile } = require("../lib/env");
const { decodeAndWriteFile } = require("../lib/files");
const {
  decrypt,
  unwrapMEK,
  decryptWithMEK,
  generateVerifier,
} = require("../lib/crypto");
const spinner = require("../lib/spinner");

async function unparkCommand(nameOrLetter) {
  // STEP 1 — PULL VAULT + RESOLVE PROJECT
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
    console.log("Run \x1b[36mparking list\x1b[0m to see all parked projects.");
    return;
  }

  const cloneTarget = path.join(process.cwd(), project.name);

  // STEP 3 — CHECK IF CLONE TARGET EXISTS
  let overwriteConfirmed = false;
  if (fs.existsSync(cloneTarget)) {
    const { overwriteAction } = await inquirer.prompt([
      {
        type: "list",
        name: "overwriteAction",
        message: cloneTarget + " already exists. What to do?",
        choices: [
          { name: "Delete existing and re-clone", value: "overwrite" },
          { name: "Cancel", value: "cancel" },
        ],
      },
    ]);

    if (overwriteAction === "cancel") {
      console.log("Cancelled.");
      return;
    }
    overwriteConfirmed = true;
  }

  // STEP 2 — DECRYPT (password prompt + MEK unwrap)
  const { masterPassword } = await inquirer.prompt([
    {
      type: "password",
      name: "masterPassword",
      message: "Master password:",
      mask: "*",
    },
  ]);

  let decryptedData = {};
  let mek = null;
  const meta = loadMeta();

  if (meta.mek_wrapped_password) {
    // New format: unwrap MEK, verify, then decrypt
    try {
      mek = unwrapMEK(meta.mek_wrapped_password, masterPassword);
    } catch (err) {
      console.error("Incorrect master password.");
      return;
    }

    // Verify with HMAC
    const computedVerifier = generateVerifier(mek);
    if (computedVerifier !== meta.verifier) {
      console.error("Incorrect master password.");
      return;
    }

    // Decrypt fields with MEK
    try {
      if (project.env_enc) {
        decryptedData.env = decryptWithMEK(project.env_enc, mek);
      }
      if (project.ssh_passphrase_enc) {
        decryptedData.sshPassphrase = decryptWithMEK(
          project.ssh_passphrase_enc,
          mek,
        );
      }
      decryptedData.extraFiles = [];
      if (project.extra_files) {
        for (const file of project.extra_files) {
          const decryptedContent = decryptWithMEK(file.data_enc, mek);
          decryptedData.extraFiles.push({
            path: file.path,
            data: decryptedContent,
          });
        }
      }
    } catch (err) {
      console.error("Incorrect master password.");
      return;
    }
  } else {
    // Legacy format: use old decrypt directly
    try {
      if (project.env_enc) {
        decryptedData.env = decrypt(project.env_enc, masterPassword);
      }
      if (project.ssh_passphrase_enc) {
        decryptedData.sshPassphrase = decrypt(
          project.ssh_passphrase_enc,
          masterPassword,
        );
      }
      decryptedData.extraFiles = [];
      if (project.extra_files) {
        for (const file of project.extra_files) {
          const decryptedContent = decrypt(file.data_enc, masterPassword);
          decryptedData.extraFiles.push({
            path: file.path,
            data: decryptedContent,
          });
        }
      }
    } catch (err) {
      console.error("Incorrect master password.");
      return;
    }
  }

  // STEP 3 — LOAD SSH KEY
  let keyPath = null;

  if (project.ssh_alias) {
    const knownKeys = parseSshConfig();
    const match = knownKeys.find((k) => k.alias === project.ssh_alias);
    if (match) {
      keyPath = match.identityFile;
    }
  }

  if (!keyPath && project.ssh_key_path) {
    if (fs.existsSync(project.ssh_key_path)) {
      keyPath = project.ssh_key_path;
    }
  }

  if (keyPath) {
    const passphrase = decryptedData.sshPassphrase || null;
    const result = addSshKey(keyPath, passphrase);
    if (!result.success) {
      console.log(
        "\x1b[33m⚠ Could not auto-load SSH key: " + result.error + "\x1b[0m",
      );
      console.log("You may be prompted for a passphrase during clone.");
    }
  }

  // STEP 4 — CLONE AND RESTORE
  let restoreRoot;
  let tmpDir = null;

  if (overwriteConfirmed) {
    tmpDir = path.join(path.dirname(cloneTarget), ".parking-tmp-" + Date.now());
  }

  const cloneDest = tmpDir || cloneTarget;

  spinner.start("Cloning from " + project.remote);
  const cloneResult = await cloneRepo(project.remote, cloneDest);

  if (!cloneResult) {
    spinner.fail("Clone failed");
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    console.error("Clone failed. Your existing directory is untouched.");
    return;
  }

  spinner.succeed("Clone completed");

  restoreRoot = cloneDest;

  // STEP 5 — RESTORE PUSH URL
  if (project.remote_push_url) {
    simpleGit(restoreRoot).remoteSetUrl([
      "--push",
      "origin",
      project.remote_push_url,
    ]);
  }

  // STEP 6 — RESTORE BRANCH IF NEEDED
  if (project.parked_branch) {
    try {
      const branches = await simpleGit(restoreRoot).branchLocal();
      if (!branches.all.includes(project.parked_branch)) {
        // Try to checkout the branch
        try {
          await simpleGit(restoreRoot).checkout([
            "-b",
            project.parked_branch,
            "origin/" + project.parked_branch,
          ]);
        } catch (err) {
          console.log(
            "\x1b[33m⚠ Could not checkout branch " +
              project.parked_branch +
              ". Using default branch.\x1b[0m",
          );
        }
      }
    } catch (err) {
      // Ignore branch checkout errors
    }
  }

  // STEP 7 — RESTORE .ENV
  if (decryptedData.env) {
    const envBuffer = Buffer.from(decryptedData.env, "base64");
    writeEnvFile(restoreRoot, envBuffer);
  }

  // STEP 8 — RESTORE EXTRA FILES
  for (const file of decryptedData.extraFiles) {
    try {
      decodeAndWriteFile(file.data, file.path, restoreRoot);
    } catch (err) {
      console.error(
        "Failed to restore extra file " + file.path + ": " + err.message,
      );
    }
  }

  // STEP 9 — SETUP COMMAND
  if (project.setup_cmd) {
    console.log("");
    console.log("Setup command: " + project.setup_cmd);

    const { runSetup } = await inquirer.prompt([
      {
        type: "list",
        name: "runSetup",
        message: "Run this setup command?",
        choices: [
          { name: "Yes", value: "yes" },
          { name: "No", value: "no" },
        ],
      },
    ]);

    if (runSetup === "yes") {
      console.log("Running setup command...");
      const result = spawnSync(project.setup_cmd, {
        cwd: restoreRoot,
        shell: true,
        stdio: "inherit",
      });

      if (result.status !== 0) {
        console.log(
          "\x1b[33m⚠ Setup command exited with non-zero status\x1b[0m",
        );
      }
    } else {
      console.log("Skipped. Run it manually when ready.");
    }
  }

  // STEP 10 — SWAP IF OVERWRITE
  if (overwriteConfirmed && tmpDir) {
    if (fs.existsSync(cloneTarget)) {
      fs.rmSync(cloneTarget, { recursive: true, force: true });
    }
    fs.renameSync(tmpDir, cloneTarget);
  }

  // STEP 11 — PRINT NOTES
  if (project.notes) {
    console.log("");
    console.log("--- Notes ---");
    console.log(project.notes);
  }

  console.log("");
  console.log(
    "Restored to " +
      (overwriteConfirmed
        ? cloneTarget
        : path.join(process.cwd(), project.name)) +
      ". Ready to work.",
  );
}

module.exports = unparkCommand;
