const fs = require("fs");
const path = require("path");

function readEnvFile(repoRoot) {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) {
    return null;
  }
  return fs.readFileSync(envPath);
}

function writeEnvFile(projectPath, contents) {
  const envPath = path.join(projectPath, ".env");
  fs.writeFileSync(envPath, contents);
}

module.exports = {
  readEnvFile,
  writeEnvFile,
};
