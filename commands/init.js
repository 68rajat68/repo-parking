const inquirer = require("inquirer");
const simpleGit = require("simple-git");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { loadConfig, saveConfig, configExists } = require("../lib/config");
const {
  encrypt,
  generateMEK,
  wrapMEK,
  wrapMEKWithRecoveryKey,
  generateRecoveryKey,
  generateVerifier,
} = require("../lib/crypto");
const spinner = require("../lib/spinner");

async function initCommand() {
  let config = loadConfig();
  let existingInit = configExists();

  if (existingInit) {
    const { reinit } = await inquirer.prompt([
      {
        type: "confirm",
        name: "reinit",
        message:
          "Already initialized. Re-initialize? This will delete and re-clone your local vault copy.",
        default: false,
      },
    ]);

    if (!reinit) {
      console.log("Cancelled.");
      return;
    }

    // Wipe corrupted or stale local clone
    const vaultPath = config.vaultPath;
    if (fs.existsSync(vaultPath)) {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  }

  const { vaultRemote } = await inquirer.prompt([
    {
      type: "input",
      name: "vaultRemote",
      message: "Vault repo remote URL:",
      validate: (input) => {
        if (!input || input.trim() === "") {
          return "Vault remote URL is required";
        }
        return true;
      },
    },
  ]);

  const { masterPassword } = await inquirer.prompt([
    {
      type: "password",
      name: "masterPassword",
      message: "Master password (never stored):",
      mask: "*",
      validate: (input) => {
        if (!input || input.trim() === "") {
          return "Master password is required";
        }
        return true;
      },
    },
  ]);

  // Generate MEK and recovery key
  const mek = generateMEK();
  const recoveryKey = generateRecoveryKey();

  // Clone vault repo
  const vaultPath = path.join(os.homedir(), ".repo-parking", "vault");

  // Ensure parent directory exists
  const vaultParent = path.dirname(vaultPath);
  if (!fs.existsSync(vaultParent)) {
    fs.mkdirSync(vaultParent, { recursive: true });
  }

  spinner.start("Cloning vault repository");

  // Detect the default branch before cloning
  let vaultBranch = "main";
  try {
    const remoteInfo = await simpleGit().listRemote([vaultRemote, "--symref"]);
    const match = remoteInfo.match(/^ref: refs\/heads\/(\S+)\tHEAD/m);
    if (match) {
      vaultBranch = match[1];
    }
  } catch (err) {
    // Fall back to 'main' if detection fails
  }

  try {
    await simpleGit().clone(vaultRemote, vaultPath);
    spinner.succeed("Vault cloned");
  } catch (cloneErr) {
    spinner.fail("Clone failed");
    if (cloneErr.message && cloneErr.message.includes("Repository not found")) {
      console.error("\n\x1b[31mERROR: Repository not found.\x1b[0m");
      console.error("Make sure:");
      console.error("  1. The vault repository exists and is accessible");
      console.error(
        "  2. You have proper SSH access (run: ssh -T git@github.com)",
      );
      console.error(
        "  3. If using SSH alias, use the full URL like git@github-68rajat68:user/repo.git",
      );
      return;
    }
    throw cloneErr;
  }

  // Check if repo has any commits (empty repo = unborn HEAD)
  let isEmptyRepo = false;
  try {
    const commitCount = await simpleGit(vaultPath).raw([
      "rev-list",
      "--count",
      "HEAD",
    ]);
    isEmptyRepo = commitCount === "0" || commitCount === "";
  } catch (err) {
    isEmptyRepo = true; // If we can't get commit count, assume empty
  }

  // P2-z fix: for empty repos, skip checkout - HEAD is already on the right branch
  // For repos with commits, try to checkout the detected/default branch
  if (!isEmptyRepo) {
    let checkoutSuccess = false;
    for (const branch of [vaultBranch, "main", "master"]) {
      try {
        await simpleGit(vaultPath).checkout([branch]);
        vaultBranch = branch;
        checkoutSuccess = true;
        break;
      } catch (err) {
        // Try next branch
      }
    }

    if (!checkoutSuccess) {
      console.error("\n\x1b[31mERROR: Could not checkout any branch.\x1b[0m");
      console.error("Make sure your vault repository has at least one commit.");
      fs.rmSync(vaultPath, { recursive: true, force: true });
      return;
    }
  }
  // For empty repos, HEAD is on unborn branch - we proceed to create files and bootstrap

  // Create projects and bundles directories and meta.json if needed
  const projectsDir = path.join(vaultPath, "projects");
  if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
  }
  const bundlesDir = path.join(vaultPath, "bundles");
  if (!fs.existsSync(bundlesDir)) {
    fs.mkdirSync(bundlesDir, { recursive: true });
  }

  const metaPath = path.join(vaultPath, "meta.json");
  let metaCreated = false;
  if (!fs.existsSync(metaPath)) {
    const mek_wrapped_password = wrapMEK(mek, masterPassword);
    const mek_wrapped_recovery = wrapMEKWithRecoveryKey(mek, recoveryKey.raw);
    const verifier = generateVerifier(mek);
    const meta = {
      retiredIds: [],
      mek_wrapped_password,
      mek_wrapped_recovery,
      verifier,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    metaCreated = true;
  }

  // If any files were created, stage and commit BEFORE pushing
  if (
    metaCreated ||
    !fs.existsSync(path.join(vaultPath, ".git", "refs", "heads", vaultBranch))
  ) {
    const git = simpleGit(vaultPath);
    await git.add("-A");
    const status = await git.status();
    if (status.files.length > 0) {
      await git.commit("init: bootstrap vault");
    }

    // P1-u fix: check isFirstCommit for rollback
    try {
      const commitCount = await git.raw(["rev-list", "--count", "HEAD"]);
      const isFirstCommit = commitCount === "1";

      spinner.start("Pushing to vault");
      try {
        await git.push(["--set-upstream", "origin", vaultBranch]);
        spinner.succeed("Pushed to vault");
      } catch (pushErr) {
        spinner.fail("Push failed");
        if (isFirstCommit) {
          const emptyTreeSha = await git.mktree(["-t", "tree"]);
          const branchName = await git.branchLocal().current;
          await git.updateRef(["-d", `refs/heads/${branchName}`]);
          await git.reset([emptyTreeSha]);
        } else {
          await git.reset(["--hard", "HEAD~1"]);
        }
        return;
      }
    } catch (err) {
      console.error("Failed to push to vault:", err.message);
      return;
    }
  }

  // Save config
  const newConfig = {
    vaultRemote: vaultRemote,
    vaultPath: vaultPath,
    vaultBranch: vaultBranch,
  };
  saveConfig(newConfig);

  // Show recovery key and require confirmation
  console.log("");
  console.log(
    "\x1b[33m╔══════════════════════════════════════════════════════╗\x1b[0m",
  );
  console.log(
    "\x1b[33m║           SAVE YOUR RECOVERY KEY                     ║\x1b[0m",
  );
  console.log(
    "\x1b[33m║                                                      ║\x1b[0m",
  );
  console.log("\x1b[33m║  " + recoveryKey.display + "      ║\x1b[0m");
  console.log(
    "\x1b[33m║                                                      ║\x1b[0m",
  );
  console.log(
    "\x1b[33m║  If you forget your master password, this key        ║\x1b[0m",
  );
  console.log(
    "\x1b[33m║  lets you reset it without losing your data.         ║\x1b[0m",
  );
  console.log(
    "\x1b[33m║  It will NOT be shown again. Store it safely.        ║\x1b[0m",
  );
  console.log(
    "\x1b[33m╚══════════════════════════════════════════════════════╝\x1b[0m",
  );
  console.log("");

  let keyConfirmed = false;
  while (!keyConfirmed) {
    const { savedKey } = await inquirer.prompt([
      {
        type: "input",
        name: "savedKey",
        message: "Have you saved your recovery key? [y/N]",
      },
    ]);
    if (savedKey.toLowerCase() === "y") {
      keyConfirmed = true;
    } else {
      console.log(
        "\x1b[33m╔══════════════════════════════════════════════════════╗\x1b[0m",
      );
      console.log(
        "\x1b[33m║           SAVE YOUR RECOVERY KEY                     ║\x1b[0m",
      );
      console.log(
        "\x1b[33m║                                                      ║\x1b[0m",
      );
      console.log("\x1b[33m║  " + recoveryKey.display + "      ║\x1b[0m");
      console.log(
        "\x1b[33m║                                                      ║\x1b[0m",
      );
      console.log(
        "\x1b[33m║  If you forget your master password, this key        ║\x1b[0m",
      );
      console.log(
        "\x1b[33m║  lets you reset it without losing your data.         ║\x1b[0m",
      );
      console.log(
        "\x1b[33m║  It will NOT be shown again. Store it safely.        ║\x1b[0m",
      );
      console.log(
        "\x1b[33m╚══════════════════════════════════════════════════════╝\x1b[0m",
      );
      console.log("");
    }
  }

  console.log(
    "\x1b[33m\x1b[1m⚠ Your master password cannot be recovered. Store it safely — it is never saved anywhere.\x1b[0m",
  );
  console.log("Initialized successfully.");
}

module.exports = initCommand;
