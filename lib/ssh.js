const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

function parseSshConfig() {
  const configPath = path.join(os.homedir(), ".ssh", "config");
  if (!fs.existsSync(configPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(configPath, "utf8");
    const lines = content.split("\n");
    const hosts = [];
    let currentHost = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        continue;
      }

      const lowerLine = trimmed.toLowerCase();
      if (lowerLine.startsWith("host ")) {
        const alias = trimmed.substring(5).trim();
        if (alias !== "*" && alias !== "") {
          currentHost = { alias, identityFile: null };
          hosts.push(currentHost);
        } else {
          currentHost = null;
        }
      } else if (lowerLine.startsWith("identityfile ") && currentHost) {
        let identityFile = trimmed.substring(13).trim();
        // Expand ~ to home directory
        if (identityFile.startsWith("~/")) {
          identityFile = path.join(os.homedir(), identityFile.substring(2));
        } else if (identityFile === "~") {
          identityFile = os.homedir();
        }
        currentHost.identityFile = identityFile;
      }
    }

    // Handle duplicate Host entries - last IdentityFile wins
    const seen = new Map();
    for (const host of hosts) {
      seen.set(host.alias, host);
    }
    return Array.from(seen.values());
  } catch (err) {
    return [];
  }
}

let tempFilesToCleanup = [];

function cleanupTempFiles() {
  for (const f of tempFilesToCleanup) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  }
  tempFilesToCleanup = [];
}

function addSshKey(keyPath, passphrase) {
  // Register cleanup handlers BEFORE creating any temp files
  const cleanup = () => {
    cleanupTempFiles();
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", cleanup);

  let tempFile = null;
  let tempScript = null;

  try {
    if (passphrase) {
      tempFile = path.join(
        os.tmpdir(),
        "repo-parking-passphrase-" + Date.now(),
      );
      tempScript = path.join(os.tmpdir(), "repo-parking-askpass-" + Date.now());

      fs.writeFileSync(tempFile, passphrase, { mode: 0o600 });
      fs.writeFileSync(tempScript, "#!/bin/sh\ncat " + tempFile + "\n", {
        mode: 0o700,
      });

      tempFilesToCleanup.push(tempFile);
      tempFilesToCleanup.push(tempScript);

      const env = {
        ...process.env,
        SSH_ASKPASS: tempScript,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: ":0",
        SSH_ASKPASS_SSH: "1",
      };

      const result = spawnSync("ssh-add", [keyPath], { env, stdio: "pipe" });
      return {
        success: result.status === 0,
        error: result.stderr ? result.stderr.toString() : null,
      };
    } else {
      const result = spawnSync("ssh-add", [keyPath], { stdio: "pipe" });
      return {
        success: result.status === 0,
        error: result.stderr ? result.stderr.toString() : null,
      };
    }
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

module.exports = {
  parseSshConfig,
  addSshKey,
};
