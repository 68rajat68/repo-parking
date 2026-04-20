const inquirer = require("inquirer");
const { loadConfig } = require("../lib/config");
const {
  ensureVaultExists,
  loadMeta,
  saveMeta,
  pushVault,
} = require("../lib/vault");
const {
  unwrapMEK,
  wrapMEK,
  wrapMEKWithRecoveryKey,
  generateRecoveryKey,
  generateVerifier,
} = require("../lib/crypto");

async function changePasswordCommand() {
  const config = loadConfig();
  if (!config) {
    console.error("Not initialized. Run `parking init` first.");
    process.exit(1);
  }

  // Pull vault
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

  const meta = loadMeta();

  // Check if vault uses legacy format
  if (!meta.mek_wrapped_password) {
    console.error("Your vault uses the legacy encryption format.");
    console.error("Run `parking migrate` to upgrade before changing password.");
    return;
  }

  // Ask for current password
  const { currentPassword } = await inquirer.prompt([
    {
      type: "password",
      name: "currentPassword",
      message: "Current master password:",
      mask: "*",
    },
  ]);

  // Unwrap MEK with current password
  let mek;
  try {
    mek = unwrapMEK(meta.mek_wrapped_password, currentPassword);
  } catch (err) {
    console.error("Incorrect current password.");
    return;
  }

  // Verify with HMAC
  const computedVerifier = generateVerifier(mek);
  if (computedVerifier !== meta.verifier) {
    console.error("Incorrect current password.");
    return;
  }

  // Ask for new password
  const { newPassword } = await inquirer.prompt([
    {
      type: "password",
      name: "newPassword",
      message: "New master password:",
      mask: "*",
    },
  ]);

  // Confirm new password
  const { confirmPassword } = await inquirer.prompt([
    {
      type: "password",
      name: "confirmPassword",
      message: "Confirm new master password:",
      mask: "*",
    },
  ]);

  if (newPassword !== confirmPassword) {
    console.error("Passwords do not match.");
    return;
  }

  // Ask about new recovery key
  const { generateNewRecoveryKey } = await inquirer.prompt([
    {
      type: "confirm",
      name: "generateNewRecoveryKey",
      message: "Generate a new recovery key?",
      default: true,
    },
  ]);

  let mek_wrapped_recovery = meta.mek_wrapped_recovery;
  let newRecoveryKey = null;

  if (generateNewRecoveryKey) {
    newRecoveryKey = generateRecoveryKey();
    mek_wrapped_recovery = wrapMEKWithRecoveryKey(mek, newRecoveryKey.raw);

    // Show new recovery key
    console.log("");
    console.log(
      "\x1b[33m╔══════════════════════════════════════════════════════╗\x1b[0",
    );
    console.log(
      "\x1b[33m║           SAVE YOUR NEW RECOVERY KEY                 ║\x1b[0",
    );
    console.log(
      "\x1b[33m║                                                      ║\x1b[0",
    );
    console.log("\x1b[33m║  " + newRecoveryKey.display + "      ║\x1b[0");
    console.log(
      "\x1b[33m║                                                      ║\x1b[0",
    );
    console.log(
      "\x1b[33m║  If you forget your master password, this key        ║\x1b[0",
    );
    console.log(
      "\x1b[33m║  lets you reset it without losing your data.         ║\x1b[0",
    );
    console.log(
      "\x1b[33m║  It will NOT be shown again. Store it safely.        ║\x1b[0",
    );
    console.log(
      "\x1b[33m╚══════════════════════════════════════════════════════╝\x1b[0",
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
          "\x1b[33m╔══════════════════════════════════════════════════════╗\x1b[0",
        );
        console.log(
          "\x1b[33m║           SAVE YOUR NEW RECOVERY KEY                 ║\x1b[0",
        );
        console.log(
          "\x1b[33m║                                                      ║\x1b[0",
        );
        console.log("\x1b[33m║  " + newRecoveryKey.display + "      ║\x1b[0");
        console.log(
          "\x1b[33m║                                                      ║\x1b[0",
        );
        console.log(
          "\x1b[33m║  If you forget your master password, this key        ║\x1b[0",
        );
        console.log(
          "\x1b[33m║  lets you reset it without losing your data.         ║\x1b[0",
        );
        console.log(
          "\x1b[33m║  It will NOT be shown again. Store it safely.        ║\x1b[0",
        );
        console.log(
          "\x1b[33m╚══════════════════════════════════════════════════════╝\x1b[0",
        );
        console.log("");
      }
    }
  } else {
    console.log("\x1b[33m⚠ Your existing recovery key still works.\x1b[0m");
  }

  // Wrap MEK with new password
  const mek_wrapped_password = wrapMEK(mek, newPassword);
  const verifier = generateVerifier(mek);

  // Save updated meta
  const updatedMeta = {
    ...meta,
    mek_wrapped_password,
    mek_wrapped_recovery,
    verifier,
  };

  // Push to vault
  saveMeta(updatedMeta);
  const success = await pushVault("security: change master password");

  if (!success) {
    // Rollback
    saveMeta(meta);
    console.error("Failed to push. Password unchanged.");
    return;
  }

  console.log(
    "✓ Master password changed. All parked projects are still accessible.",
  );
}

module.exports = changePasswordCommand;
