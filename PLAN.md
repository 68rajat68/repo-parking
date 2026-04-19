# repo-parking CLI - Implementation Plan v4

## Context

Developers with limited disk space need a reliable system to park (remove locally) git repos and
restore them later on any machine via a private GitHub "vault" repo. This plan is the complete
specification for implementation. Do not deviate from it.

**Platform support:** macOS and Linux only. Windows is not supported (`rm -rf`, SSH behavior,
and path handling are Unix-specific). State this prominently in README.

---

## Project Structure

repo-parking/
├── bin/
│ └── parking.js
├── commands/
│ ├── init.js
│ ├── park.js
│ ├── unpark.js
│ ├── list.js
│ ├── status.js
│ └── forget.js
├── lib/
│ ├── config.js
│ ├── crypto.js
│ ├── vault.js
│ ├── git.js
│ ├── ssh.js
│ ├── env.js
│ └── files.js
├── package.json
└── README.md

---

## bin/parking.js — Startup Guards

These two checks run before anything else, before commander parses arguments:

```javascript
// 1. Node version check
const [major] = process.version.replace("v", "").split(".").map(Number);
if (major < 18) {
  console.error(
    "repo-parking requires Node.js v18+. Current: " + process.version,
  );
  process.exit(1);
}

// 2. --version flag (before commander setup)
// commander handles this automatically via .version('1.0.0')

// 3. COMMANDER EXIT OVERRIDE (Issue #6)
// Commander calls process.exit() automatically on errors. This prevents rollback
// logic in pushVault from running. Fix: add exitOverride() BEFORE adding commands.
//   program.exitOverride()
// After this, all errors in command handlers return via throwing instead of exiting,
// so try/catch blocks around commands can run cleanup code (e.g., pushVault rollback).
```

Every command handler except `init` must begin with:

```javascript
const config = loadConfig();
if (!config) {
  console.error("Not initialized. Run `parking init` first.");
  process.exit(1);
}
```

---

## Project Name Validation

Project names are validated at `parking park` time before anything else.
A valid name must:

- Contain only alphanumeric characters, hyphens, and underscores: `/^[a-zA-Z0-9_-]+$/`
- Not be empty
- Not match the ID pattern (all uppercase letters only): reject names matching `/^[A-Z]+$/`
  Reason: the lookup resolver checks ID pattern first. A name like `A`, `AA`, or `API` would
  always be resolved as an ID, making it unreachable by name in unpark/status/forget.
  If user tries such a name, show: "Names cannot be all uppercase letters (reserved for IDs).
  Try: my-API, api-server, etc."
- Not contain path separators (`/`, `\`) or dot-segments (`..`, `.`)
  Reason: project name is used as the git clone target directory. A name like `../work` or
  `a/b` would clone outside the intended location.

Validate this before asking for master password or doing any git operations.

---

## Commands Specification

### `parking init`

**Flow:**

1. If `~/.repo-parkingrc` exists:
   - Ask: "Already initialized. Re-initialize? This will delete and re-clone your local vault copy."
   - If no: exit cleanly
   - If yes: `rm -rf ~/.repo-parking/vault` (wipe corrupted or stale local clone completely)
2. Prompt: vault repo remote URL
3. Prompt: master password (never stored)
4. Clone vault repo to `~/.repo-parking/vault`
5. Detect the default branch after clone:

```javascript
// git rev-parse --abbrev-ref HEAD returns "HEAD" on a freshly cloned empty repo.
// Use git ls-remote to ask the remote what its default branch is before pushing:
const remoteInfo = await simpleGit().listRemote([vaultRemote, "--symref"]);
// remoteInfo is a multi-line string like "ref: refs/heads/main\tHEAD\n..." where the
// first line with "HEAD" and a tab before the branch name is the default branch.
// Parse: extract the branch from the line matching /^ref: refs\/heads\/(\S+)\tHEAD/m
// If parsing fails (old Git, non-standard setup): fall back to "main"
// Store as vaultBranch in ~/.repo-parkingrc
//
// IMPORTANT: Do NOT use git rev-parse --abbrev-ref HEAD on an empty fresh clone —
// it returns "HEAD", not the default branch name. The git push --set-upstream
// below handles this correctly, but we also store vaultBranch for later use.
// vaultBranch is used to set up the local tracking relationship.
```

6. Check if `vault/projects/` exists — create if not (`fs.mkdirSync` recursive)
7. Check if `vault/meta.json` exists — create if not with `{ "retiredIds": [] }`
8. If any files were created (projects dir or meta.json):
   Stage and commit BEFORE pushing:
   `await simpleGit(vaultPath).add('-A')`
   `const status = await simpleGit(vaultPath).status()`
   `if (status.files.length > 0) { await simpleGit(vaultPath).commit('init: bootstrap vault') }`
   **P1-t fix — do NOT checkout on fresh clone:** On a freshly cloned empty repo, HEAD
   is on an unborn branch. `git checkout <branch>` errors with " unborn branch" instead
   of acting as no-op. Skip checkout entirely — the unborn HEAD already carries the
   right branch name. Instead, just push:
   `await simpleGit(vaultPath).push(['--set-upstream', 'origin', vaultBranch])`
   This works because the local unborn branch and remote branch are already linked by name
   via the symref that `git ls-remote --symref` returned.
   **FIRST-PUSH ROLLBACK SAFETY (P1-u fix):** see pushVault() fix below. If this first
   push fails, the same `isFirstCommit` rollback applies: use `reset --hard HEAD^` before
   deleting the branch ref (not `reset HEAD~1` after, which would fail with detached HEAD).
9. Save config to `~/.repo-parkingrc`
10. Print: "⚠ Your master password cannot be recovered. Store it safely — it is never saved anywhere."

**Config file format:**

```json
{
  "vaultRemote": "git@github.com:user/vault.git",
  "vaultPath": "/Users/user/.repo-parking/vault",
  "vaultBranch": "main"
}
```

---

### `parking park <name>`

**Full ordering — do not reorder these steps:**
name validation → repo root → remote resolution →
password → duplicate detection → git safety → config questions →
snapshot + letter assignment → vault push → local delete

---

**STEP 0 — VALIDATE NAME:**

- Apply name validation rules (see Project Name Validation above)
- Exit with clear message if invalid

---

**STEP 1 — RESOLVE REPO ROOT:**

- `git rev-parse --is-inside-work-tree` — if fails: "Not inside a git repository." exit
- `git log --oneline -1` — if fails (no commits): "No commits yet. Make at least one commit." exit
- `git rev-parse --show-toplevel` → store as `repoRoot`
- All subsequent file operations use `repoRoot`, never `process.cwd()`

---

**STEP 2 — RESOLVE CLONEABLE REMOTE:**

Goal: find a remote URL suitable for `git clone` and later `git push`.

Get current branch:
git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --abbrev-ref HEAD
If the result is "HEAD" (detached HEAD state):
error: "Cannot park a repo in detached HEAD state. Check out a branch first."
exit
Store as trackingBranch.
Check for configured upstream:
git rev-parse --abbrev-ref --symbolic-full-name @{u}
→ returns e.g. "origin/main" → parse remoteName="origin", trackingBranch="main"
→ run: git remote get-url <remoteName> → store as remoteUrl
→ Also check: git config remote.<remoteName>.pushurl → if set, store as remotePushUrl
→ **P1-s fix — reject credential-bearing URLs:** Before storing either URL, check:

- remoteUrl: if URL matches /^https?:\/\/[^@]+@/i → reject with error above
- remotePushUrl: if URL matches /^https?:\/\/[^@]+@/i → reject with:
  "Push URL contains embedded credentials. Remove credentials and use a token without
  username. SSH URLs do not have this issue."
  This prevents GitHub PATs, HTTPS passwords, and GitLab deploy tokens from being
  committed to the vault in plaintext and shown in list/status output.
  → if this succeeds: use this remote. Done.
  If no upstream configured:
  → run: git remote
  → collect all remote names as a list
  If list is empty:
  → error: "No remotes configured. Add a remote and push at least once before parking."
  → exit
  If list has exactly one remote:
  → use that remote name automatically
  → run: git remote get-url <name> → store as remoteUrl
  → Also check: git config remote.<name>.pushurl → if set, store as remotePushUrl
  → **Apply credential check (P1-s fix)** before storing.
  → remoteName = <name>, trackingBranch = <branch>, hasUpstream = false
  If list has multiple remotes and no upstream:
  → show numbered list of remotes with their URLs
  → ask user to pick which one to use for parking
  → store chosen remoteName, run git remote get-url to get remoteUrl
  → Also check: git config remote.<chosen>.pushurl → if set, store as remotePushUrl
  → **Apply credential check (P1-s fix)** before storing.
  → remoteName = chosen, trackingBranch = <branch>, hasUpstream = false

Store: `{ remoteName, trackingBranch, remoteUrl, remotePushUrl, hasUpstream }` for use in Steps 1 and 3.
If list has multiple remotes and no upstream:
→ show numbered list of remotes with their URLs
→ ask user to pick which one to use for parking
→ store chosen remoteName, run git remote get-url to get remoteUrl
→ Also check: git config remote.<chosen>.pushurl → if set, store as remotePushUrl
→ remoteName = chosen, trackingBranch = <branch>, hasUpstream = false

Store: `{ remoteName, trackingBranch, remoteUrl, remotePushUrl, hasUpstream }` for use in Steps 1 and 3.

---

**STEP 3 — DUPLICATE DETECTION:**

- Pull latest vault repo via `ensureVaultExists()`
- Scan all `vault/projects/*.json`
- `name_match`: project.name === `<name>` (case-sensitive)
- `remote_match`: project.remote === resolved `remoteUrl`
- Decision matrix:
  - **0 matches:** proceed as new
  - **1 match:** show details, ask [O]verwrite / [N]ew entry / [C]ancel
  - **2 matches, different projects:** show both labeled A and B, ask [O-A] / [O-B] / [N] / [C]
- **[N] with name_match:** force user to provide a different name (re-validate), use new name going forward
- **On overwrite:** keep same letter/id, update all fields in Step 5 (PROJECT CONFIGURATION)

---

**STEP 4 — PROMPT MASTER PASSWORD:**

- Ask for master password (hidden input, not echoed)
- Hold in memory for Step 7 (snapshot) — never written anywhere
- Print: "⚠ Your master password cannot be recovered. Make sure you remember it."
  (only print this on first park — check if any projects exist in vault yet)

---

**STEP 5 — GIT SAFETY CHECK:**

All operations run from `repoRoot`. Use `{ cwd: repoRoot }` in all git calls.
uncommittedFiles = getUncommittedFiles() // git status --porcelain from repoRoot
unpushedCommits = getUnpushedCommits(remoteName, trackingBranch, hasUpstream)
Cases:
Both uncommitted AND unpushed:
→ show: "X uncommitted file(s), Y unpushed commit(s)"
→ ask [M] handle manually (exit) / [R] let parking do it
→ if R: prompt commit message → commitAndPush(message, remoteName, trackingBranch, hasUpstream)
Only unpushed (clean working tree):
→ do NOT run git commit (nothing to commit — would fail)
→ run pushOnly(remoteName, trackingBranch, hasUpstream) directly
Only uncommitted:
→ ask [M] / [R]
→ if R: prompt commit message → commitAndPush(...)
Nothing to do:
→ continue

After any push: verify it returned true. If false: show "Push failed. Aborting." exit.

---

**STEP 6 — PROJECT CONFIGURATION:**

- If new project or [N] new entry: ask all questions
- If [O] overwrite: show existing values, ask [K]eep / [U]pdate

Questions:

1. **Setup command?**
   - Example hint shown: "e.g. npm install, pip install -r requirements.txt, yarn"
   - Accept any string — security note in README (vault is private, user controls it)
   - On `unpark`, show the command and ask "Run this setup command? [Y/n]" before executing
     (this is the sanitization step — user sees and confirms before anything runs)

2. **Extra files?**
   - Comma-separated relative paths, e.g. `config/local.json,certs/dev.pem`
   - Validate each path:
     - Must not start with `/` or contain `..` segments
     - Must pass segment-aware root check (see lib/files.js `validateRelativePath`)
   - Validate sizes: warn >500KB, hard refuse >1MB (abort park)

3. **SSH host alias?**
   - `parseSshConfig()` → show numbered list of `{ alias, identityFile }` pairs
   - If `~/.ssh/config` has duplicate Host entries for same alias: merge them, use the last
     `IdentityFile` found (last-wins, same as OpenSSH behavior)
   - If user selects from the list: ssh_alias = alias, ssh_key_path = identityFile (known)
   - **P2-8 FIX — custom alias:** If user types a custom alias (not from list):
     - Also ask: "Enter the private key path for this alias:" (accept absolute path)
     - ssh_alias = custom alias string, ssh_key_path = user-provided absolute path
     - Validate the file exists; if not, re-prompt
   - If user skips: ssh_alias = null, ssh_key_path = null (no SSH key loading on unpark)
   - **P2-aa fix — portable SSH key storage:**
     Store `ssh_alias` as the primary identifier (maps to ~/.ssh/config on any machine).
     Store `ssh_key_path` only as a fallback hint — it may be invalid on unpark machines
     (different home directory, different key filename).
     The vault schema stores both fields. On unpark, prefer resolving ssh_alias via the
     current machine's ~/.ssh/config. If ssh_alias is null or its key cannot be found
     on this machine, fall back to ssh_key_path if it exists on this machine. If no key
     is found, set ssh_key_path = null and skip SSH key auto-loading (user must pre-load
     manually via ssh-add before running unpark).

4. **SSH passphrase?**
   - If user says yes: ask if they want to store it encrypted in vault
   - If stored: encrypted with AES-256-GCM
   - Print note: "If you choose not to store it, you will be prompted manually on unpark."

5. **Notes?** Free text, shown after unpark.

---

**STEP 7 — SNAPSHOT + LETTER ASSIGNMENT:**

Do these in order — letter is assigned as late as possible:

Read .env from repoRoot (null if not exists)
Read each extra file from repoRoot (validated paths)
Check sizes — refuse if any >1MB
**ROUND-TRIP ENCODING (P1-5 fix):** Encode all files as base64 BEFORE encrypting:
env_raw = readEnvFile(repoRoot) → Buffer | null
env_enc = env_raw ? encrypt(env_raw.toString('base64'), password) : null
For each extra file:
file_raw = fs.readFileSync(filePath) → Buffer
file_b64 = file_raw.toString('base64') ← base64-encode bytes first
data_enc = encrypt(file_b64, password) ← encrypt the base64 string
ssh_passphrase_enc = encrypt(passphrase, password) or null
Load vault meta: loadMeta() → { retiredIds }
Load all active project IDs from vault/projects/\*.json
allUsedIds = retiredIds ∪ activeIds
Assign letter: id = getNextLetter(allUsedIds)
Build project JSON object (see schema)
**NOTE:** Store two separate fields:

- `remote` = `remoteUrl` (fetch URL — always used for clone)
- `remote_push_url` = `remotePushUrl` if set, otherwise absent
  These are NOT merged — `remote` is for cloning, `remote_push_url` is for restoring push URL.
  fs.mkdirSync(vault/projects/, { recursive: true })
  saveProject(id, data) → writes vault/projects/<id>.json
  Show "Pushing to vault..."
  success = pushVault("park: add project " + name)
  If success === false:
  show "Vault push failed. Your local folder is safe. Check connection and try again."
  exit (do NOT proceed to delete)

---

**STEP 8 — DELETE:**

Only reached if pushVault returned true.
Show: "This will permanently delete <repoRoot>. Type the project name to confirm:"
Read input → if input !== name: show "Cancelled." exit
rm -rf <repoRoot>
Print: "Parked as [<id>]. Use parking unpark <id> to restore."

---

### `parking unpark <name or letter>`

**Full ordering — do not reorder:**
check dir → pull vault → resolve → read JSON →
ask password → decrypt → load SSH → clone → restore → setup

---

**STEP 1 — CHECK CLONE TARGET FIRST:**
cloneTarget = path.join(process.cwd(), projectName)
// We don't know projectName yet — we know the input (name or letter)
// So: pull vault, resolve project, get name, THEN check directory
// But we do NOT ask for password yet

So the actual order is:

1. Pull latest vault via `ensureVaultExists()`
2. Resolve input:
   - If matches `/^[A-Z]+$/` pattern: look up by `id` field in JSONs (read without decrypting)
   - Otherwise: look up by `name` field
   - If not found: show "Project not found." + show `parking list` output → exit
3. Read the project JSON (not decrypted yet — just parse the file)
4. Determine `cloneTarget = path.join(process.cwd(), project.name)`
5. **Check if `cloneTarget` already exists:**
   - If yes: ask [O] delete existing and re-clone / [C] cancel
   - If [C]: exit cleanly (no password asked, no SSH loaded — user cancelled early)
   - If [O]: SAVE this decision — do NOT delete yet. Mark `overwriteConfirmed = true`.

---

**STEP 2 — DECRYPT:** 6. Ask for master password (hidden input) 7. Decrypt all encrypted fields — if any decryption throws: show "Incorrect master password." exit

---

**STEP 3 — LOAD SSH KEY:**

Always attempt to load SSH key before clone — not only when passphrase is stored.
**P2-aa fix — machine-independent key resolution:**

```
keyPath = null
if (project.ssh_alias) {
  // Try to resolve alias from current machine's ~/.ssh/config
  const knownKeys = parseSshConfig() // [{ alias, identityFile }, ...]
  const match = knownKeys.find(k => k.alias === project.ssh_alias)
  if (match) {
    keyPath = match.identityFile  // use this machine's path for the alias
  }
}
// Fall back to stored key path if alias not found or not set
if (!keyPath && project.ssh_key_path) {
  if (fs.existsSync(project.ssh_key_path)) {
    keyPath = project.ssh_key_path
  }
  // If path doesn't exist on this machine: skip auto-loading, user must ssh-add manually
}
if (keyPath) {
  passphrase = project.ssh_passphrase_enc ? decrypt(project.ssh_passphrase_enc, password) : null
  result = addSshKey(keyPath, passphrase)
  if (!result.success) {
    print "⚠ Could not auto-load SSH key: " + result.error
    print "You may be prompted for a passphrase during clone."
    // Do NOT abort — continue to clone
  }
}
```

// Do NOT abort — continue to clone
}
}

**Important:** `ssh-add` does NOT reliably read passphrases from stdin on all OpenSSH
implementations. Use the `SSH_ASKPASS` + `DISPLAY` environment variable technique instead:

```javascript
// In lib/ssh.js addSshKey(keyPath, passphrase):
// If passphrase is provided:
//   1. Write passphrase to a temp file (mode 0600)
//   2. Create a tiny shell script that echoes the passphrase (SSH_ASKPASS helper)
//   3. Set env: SSH_ASKPASS=<script path>, SSH_ASKPASS_REQUIRE=force, DISPLAY=:0
//   4. spawn('ssh-add', [keyPath], { env: modifiedEnv, detached: false })
//   5. Clean up temp files in finally block regardless of success/failure
// If no passphrase:
//   spawn('ssh-add', [keyPath]) with no special env
// Return { success: boolean, error: string | null }
// Never throw — always return result object
```

---

**STEP 4 — CLONE AND RESTORE:**

**SAFE OVERWRITE ORDERING (P1-3 fix):** Do NOT delete cloneTarget until AFTER
clone, branch restore, .env write, and extra-file restoration ALL succeed.
This prevents data loss if password is wrong, decryption fails, clone fails,
or post-clone restoration fails.

8. If `overwriteConfirmed === true`: clone to a temp location, do ALL restoration
   there, swap into place only at the very end:

   ```
   tmpDir = path.join(path.dirname(cloneTarget), '.parking-tmp-' + Date.now())
   git clone <project.remote> <tmpDir>
   If clone fails:
     fs.rmSync(tmpDir, { recursive: true, force: true }) if it exists
     print "Clone failed. Your existing directory is untouched."
     exit
   // ALL restoration steps below happen inside tmpDir, not cloneTarget
   restoreRoot = tmpDir

   ```

   If `overwriteConfirmed === false`: normal clone to `cloneTarget` (must not exist)
   `restoreRoot = cloneTarget`

   **P2-y fix — reapply push URL for ALL clones (not just overwrite):**
   After any successful clone (tmpDir or cloneTarget):
   If `project.remote_push_url` is set:
   `git -C <restoreRoot> remote set-url --push origin <project.remote_push_url>`

   **Then perform ALL restoration steps 10-13 inside restoreRoot before swapping.**

9. **ONLY AFTER successful clone:** restore branch if different from default:
   If `project.parked_branch` exists and differs from remote default:
   `git -C <restoreRoot> checkout -b project.parked_branch origin/project.parked_branch`
   If checkout fails (branch deleted on remote): warn but continue on default branch.
10. Write `.env` to `path.join(<restoreRoot>, '.env')` if `env_enc` was stored
11. For each extra file:
    - `decodeAndWriteFile(data_enc_decrypted, relPath, <restoreRoot>)`
    - Uses segment-aware path validation (see lib/files.js)
      If any decodeAndWriteFile throws: propagate error — do NOT swap.

12. Show stored setup command: "Setup command: <cmd>. Run it? [Y/n]"
    - If yes (default): `spawn(cmd, { cwd: <restoreRoot>, shell: true, stdio: 'inherit' })`
      (shell:true needed for commands like `npm install` which may be shell scripts)
    - If no: skip, remind user to run it manually

    **ONLY AFTER all steps 10-13 succeed, swap into place:**
    If `overwriteConfirmed === true`:

    ```
    if (fs.existsSync(cloneTarget)) { fs.rmSync(cloneTarget, { recursive: true, force: true }) }
    fs.renameSync(tmpDir, cloneTarget)
    ```

    **CRITICAL (P1-f fix):** Use `path.join(path.dirname(cloneTarget), '.parking-tmp-...')`
    as the temp location. This guarantees the temp dir is on the same filesystem
    as cloneTarget, so renameSync does not fail with EXDEV (cross-device link error).
    Never use os.tmpdir() — that may be on a different volume.

13. If notes exist: print "--- Notes ---\n<notes>"
14. Print: "Restored to <cloneTarget>. Ready to work."

---

### `parking list`

1. Check config exists
2. Attempt `ensureVaultExists()`:
   - If pull fails (no internet): print "⚠ Could not reach vault. Showing cached local data."
     then continue reading local vault files (do not crash)
   - If local vault doesn't exist at all: print error and exit
3. Load all `vault/projects/*.json`
4. Sort by `parked_at` descending (most recent first)
5. Display table:
   LetterNameRemoteParkedAmy-appgit@github.com:user/repo.git2 days agoCapi-servergit@github.com:user/api.git1 week ago
   (B is missing — forgotten. This is expected. No explanation needed in table.)
6. If no projects: show helpful empty state with quick-start instructions

---

### `parking status <name or letter>`

1. Check config exists
2. `ensureVaultExists()` (with same offline fallback as list)
3. Resolve project — if not found: show error + list output → exit
4. Display:
   - Letter, name, remote
   - ssh_alias, ssh_key_path, setup_cmd
   - Notes
   - .env stored: yes/no
   - Extra files: list of paths (no contents)
   - parked_at: "April 17 2026 (2 days ago)"

---

### `parking forget <name or letter>`

1. Check config exists
2. `ensureVaultExists()`
3. Resolve project — if not found: show error + list output → exit
4. Show full summary of project to be forgotten
5. Print: "This does NOT delete your GitHub repo. Only removes the vault entry."
6. Print: "⚠ If you have not unparked this project recently, you will lose access to its .env and extra files."
7. Ask: "Type the project name to confirm:"
8. If wrong: "Cancelled." exit

9. Execute with rollback safety:
   // Save current state for rollback
   projectData = read vault/projects/<id>.json into memory
   meta = loadMeta()
   // Make local changes
   deleteProject(id) // delete vault/projects/<id>.json
   newMeta = { retiredIds: [...meta.retiredIds, id] }
   saveMeta(newMeta) // update vault/meta.json
   // Attempt push
   success = pushVault("forget: remove project " + name)
   if (!success):
   // ROLLBACK — restore both files
   saveProject(id, projectData) // restore vault/projects/<id>.json
   saveMeta(meta) // restore original meta.json
   print "Could not reach vault. No changes were made. Try again when online."
   exit
   print "Forgotten. Letter [<id>] is retired and will never be reused."

---

### `parking --version`

Handled automatically by commander:

```javascript
program.version("1.0.0", "-v, --version", "Print version number");
```

Prints `1.0.0` when user runs `parking --version` or `parking -v`.

---

## `pushVault()` — Commit + Push with Rollback

**Critical:** `pushVault()` must commit locally AND push. If push fails, the local commit
must be rolled back to keep local and remote in sync. Otherwise later `git pull` commands
will fail with diverged history.

```javascript
// In lib/vault.js pushVault(message):
async function pushVault(message) {
  const git = simpleGit(vaultPath);
  try {
    await git.add("-A");

    // Check if there is anything to commit
    const status = await git.status();
    if (status.files.length === 0) {
      return true; // nothing to commit, vault already up to date
    }

    await git.commit(message);

    // FIRST-COMMIT DETECTION (P1-2): before push, check if this is the vault's
    // very first commit. git rev-list --count HEAD returns "1" in that case.
    // Store this flag — if push fails and this was the first commit, we cannot
    // use git reset HEAD~1 (fails: "ambiguous object name"). Instead, use
    // git update-ref -d refs/heads/<currentBranch> to delete the branch ref.
    const commitCount = await git.revList(["--count", "HEAD"]);
    const isFirstCommit = commitCount === "1";

    try {
      await git.push();
      return true;
    } catch (pushErr) {
      // ROLLBACK: undo the local commit AND restore worktree to pre-call state.
      // CRITICAL (P1-p fix): --soft leaves vault/projects/X.json staged/in worktree.
      // A subsequent pushVault() would pick up those residual changes and recommit them
      // silently, publishing a park/forget that was supposed to be aborted.
      // We need the vault to be truly identical to its pre-call state.
      if (isFirstCommit) {
        // P1-x fix: ROOT COMMIT special case — HEAD^ does not exist for a root commit.
        // Cannot use `reset --hard HEAD^` (fails: "unknown commit" on root commit).
        // Instead:
        // 1. Get the empty tree SHA (represents "no files")
        const emptyTreeSha = await git.mktree(["-t", "tree"]);
        // 2. Get current branch name while HEAD is still attached
        const branchName = await git.branchLocal().current;
        // 3. Delete the branch ref — this detaches HEAD but worktree still has root commit files
        await git.updateRef(["-d", `refs/heads/${branchName}`]);
        // 4. Reset --hard to empty tree — clears worktree and index to "no files" state
        await git.reset([emptyTreeSha]);
        // Vault is now in the exact pre-call empty state: 0 commits, no branch ref,
        // worktree clean. Future pull/push operations start from a clean slate.
      } else {
        // --hard: undoes the commit AND restores all worktree files to pre-call state.
        // park: vault/projects/X.json was added — hard reset removes it from worktree ✓
        // forget: vault/projects/X.json was deleted — hard reset restores it to worktree ✓
        await git.reset(["--hard", "HEAD~1"]);
      }
      return false;
    }
  } catch (err) {
    return false;
  }
}
```

This guarantees: if `pushVault()` returns `false`, the local vault is in the exact same
state as before the call — no orphaned local commit, worktree fully restored to pre-call
state (using --hard), even on first-commit push failure.

---

## `ensureVaultExists()` — Vault Clone/Pull with Corruption Check

```javascript
async function ensureVaultExists() {
  const gitDir = path.join(vaultPath, ".git");

  if (!fs.existsSync(vaultPath) || !fs.existsSync(gitDir)) {
    // Either directory missing or exists but not a valid git repo (partial/corrupted clone)
    if (fs.existsSync(vaultPath)) {
      fs.rmSync(vaultPath, { recursive: true, force: true }); // wipe corrupted clone
    }
    await simpleGit().clone(vaultRemote, vaultPath);
    // P2-z fix: after re-clone, switch to the configured vaultBranch.
    // A fresh clone leaves HEAD pointing at the remote's default branch (may differ from
    // vaultBranch if user changed their default branch after init). Subsequent pushVault()
    // and pull() calls must operate on vaultBranch, not the remote's possibly-changed HEAD.
    // Use git checkout -b <vaultBranch> to create a local tracking branch from the remote ref.
    await simpleGit(vaultPath).checkout([vaultBranch]);
    return;
  }

  // Valid git repo exists — attempt pull
  try {
    await simpleGit(vaultPath).pull();
  } catch (err) {
    // Pull failed (offline, auth error, etc.) — return without throwing
    // Callers decide whether to use cached data or abort
    throw new Error("VAULT_PULL_FAILED: " + err.message);
  }
}
```

Callers that can tolerate offline (list, status): catch `VAULT_PULL_FAILED` and warn.
Callers that require fresh data (park, unpark, forget): let it propagate and exit with error.

---

## Vault Structure

vault/
├── meta.json # { "retiredIds": ["B", "D"] }
└── projects/
├── A.json
├── C.json # B was forgotten (B.json deleted, "B" in retiredIds)
└── E.json # D was forgotten

---

## Vault JSON Schema

**Filename:** `vault/projects/<id>.json` (A.json, B.json — never named by project name)

```json
{
  "id": "A",
  "name": "my-app",
  "remote": "git@github.com:user/repo.git",
  "remote_push_url": "git@github.com:user/repo.git",
  "parked_branch": "feature/my-feature",
  "ssh_alias": "github-personal",
  "ssh_key_path": "/Users/user/.ssh/id_ed25519_personal",
  "ssh_passphrase_enc": "<base64 or null>",
  "setup_cmd": "npm install",
  "notes": "Run on port 3000.",
  "env_enc": "<base64 or null>",
  "extra_files": [
    {
      "path": "config/local.json",
      "data_enc": "<base64>"
    }
  ],
  "parked_at": "2026-04-17T10:30:00Z"
}
```

All encrypted values are base64 strings or null. `parked_branch` is the branch that was
active when the repo was parked (e.g. "feature/foo"). On unpark, if this differs from
the remote's default branch, the repo is checked out to parked_branch after clone.
`extra_files[].path` is stored relative to the repo root (e.g. "config/local.json").
`remote` always stores the fetch URL (what `git remote get-url` returns).
`remote_push_url` stores the push URL if `remote.<name>.pushurl` was configured,
otherwise absent/null. On unpark: clone uses `remote` (fetch URL), then if `remote_push_url`
exists, run `git -C <cloneTarget> remote set-url --push origin <remote_push_url>` to
restore the push URL. This preserves separate fetch/push URL semantics (P1-q fix).

---

## Library Specifications

### lib/crypto.js

**Byte layout:**
[0..31] salt 32 bytes random per call
[32..47] IV 16 bytes random per call
[48..N-17] ciphertext variable
[N-16..N-1] authTag 16 bytes GCM tag
Minimum total: 64 bytes

```javascript
encrypt(plaintext, password):
  salt = crypto.randomBytes(32)
  iv   = crypto.randomBytes(16)
  key  = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256')
  cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  authTag = cipher.getAuthTag()
  return Buffer.concat([salt, iv, encrypted, authTag]).toString('base64')

decrypt(encryptedData, password):
  buf      = Buffer.from(encryptedData, 'base64')
  salt     = buf.slice(0, 32)
  iv       = buf.slice(32, 48)
  authTag  = buf.slice(buf.length - 16)
  cipher   = buf.slice(48, buf.length - 16)
  key      = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256')
  decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  try:
    return Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8')
  catch:
    throw new Error('Incorrect master password')
```

---

### lib/config.js

```javascript
loadConfig(); // Parse ~/.repo-parkingrc → return object or null
saveConfig(config); // Write ~/.repo-parkingrc
configExists(); // fs.existsSync check → boolean
```

---

### lib/vault.js

```javascript
ensureVaultExists(); // See full implementation above
loadProject(idOrName); // If /^[A-Z]+$/ matches: read <id>.json directly
// Else: scan all JSONs, find by name field
// Return null if not found (do not throw)
saveProject(id, data); // mkdirSync vault/projects/ first. Write <id>.json.
deleteProject(id); // fs.unlinkSync vault/projects/<id>.json
listProjects(); // Glob vault/projects/*.json, parse all, sort by parked_at desc
loadMeta(); // Read vault/meta.json. If not exists: return { retiredIds: [] }
saveMeta(meta); // Write vault/meta.json
pushVault(message); // See full implementation above. Returns boolean.
```

---

### lib/git.js

```javascript
isGitRepo();
// git rev-parse --is-inside-work-tree
// Return boolean, never throw

hasCommits();
// git log --oneline -1
// Return boolean (false if non-zero exit)

getRepoRoot();
// git rev-parse --show-toplevel
// Return absolute path string

getUpstreamInfo();
// See STEP 2 remote resolution algorithm above (includes detached HEAD check)
// Return { remoteName, trackingBranch, remoteUrl, remotePushUrl, hasUpstream }
// remotePushUrl is the pushurl if set, otherwise undefined
// Return null only if zero remotes exist
// IMPORTANT: getUpstreamInfo must call git symbolic-ref --short HEAD first to detect
// detached HEAD. If result is "HEAD", throw Error("Cannot park in detached HEAD state")
// before any other git operations. This prevents bad branch names from propagating
// into push and commit operations.

getUncommittedFiles(repoRoot);
// git status --porcelain=v1 run with cwd: repoRoot (Issue #8)
// Filter out empty strings and whitespace-only lines before counting
// Return array of non-empty status line strings (empty = clean)
// CRITICAL: parsePorcelainLine() helper must strip whitespace and reject blank lines

getUnpushedCommits(remoteName, trackingBranch, hasUpstream, repoRoot);
// If hasUpstream === false: git log HEAD --oneline (all local commits = unpushed)
// Else: git log <remoteName>/<trackingBranch>..HEAD --oneline
//   If that ref doesn't exist: fall back to git log HEAD --oneline
// Run with cwd: repoRoot
// Return array of commit line strings

commitAndPush(message, remoteName, trackingBranch, hasUpstream, repoRoot);
// git add . (cwd: repoRoot)
// git commit -m message (cwd: repoRoot)
// if hasUpstream: git push
// else: git push --set-upstream <remoteName> <trackingBranch>
// Return boolean success

pushOnly(remoteName, trackingBranch, hasUpstream, repoRoot);
// if hasUpstream: git push
// else: git push --set-upstream <remoteName> <trackingBranch>
// Return boolean success

cloneRepo(remoteUrl, targetPath);
// MUST be async function using simple-git (Issue #2).
// Using spawnSync for git ops would bypass simple-git internal lock handling
// and could cause race conditions in nested/parallel git calls.
//   await simpleGit().clone(remoteUrl, targetPath, ['--progress'])
// stdio: inherit is handled by simple-git automatically (pass { progress: true } handler
// or rely on simple-git default progress output to parent process)
// Return boolean success (true = clone succeeded, false = failed)
```

---

### lib/ssh.js

```javascript
parseSshConfig();
// Read ~/.ssh/config (return [] if not exists)
// Split into Host blocks
// For each block:
//   alias = Host value (skip if "*")
//   identityFile = IdentityFile value expanded with os.homedir()
//   If same alias appears multiple times: last IdentityFile wins (OpenSSH behavior)
// Return [{ alias, identityFile }, ...]

addSshKey(keyPath, passphrase);
// keyPath is absolute (no ~ expansion needed)
//
// ZOMBIE FILE PROTECTION (Issue #3):
// Register cleanup handlers BEFORE creating any temp files.
// These fire even on Ctrl+C (SIGINT), SIGTERM, and normal exit:
//   process.on('SIGINT', cleanup)
//   process.on('SIGTERM', cleanup)
//   process.on('exit', cleanup)
// cleanup() deletes any temp files this function created.
//
// SSH_ASKPASS FALLBACK FOR HEADLESS (Issue #1):
// Many systems ignore SSH_ASKPASS if DISPLAY=:0 fails (headless servers, macOS without X11).
// Add SSH_ASKPASS_SSH env var as additional fallback signal:
//   env = { ...process.env, SSH_ASKPASS: tempScript, SSH_ASKPASS_REQUIRE: 'force',
//           DISPLAY: ':0', SSH_ASKPASS_SSH: '1' }
//
// EXECUTABLE SCRIPT REQUIREMENT (Issue #1):
// tempScript MUST be chmod 0o700 BEFORE ssh-add runs. If not executable, ssh-add
// ignores SSH_ASKPASS silently and hangs waiting for TTY input.
//
// If passphrase provided:
//   Write passphrase to tempFile (fs.writeFileSync, mode 0o600)
//   Write askpass script to tempScript:
//     #!/bin/sh
//     cat <tempFile>
//   chmod 0o700 tempScript  ← MUST happen before ssh-add
//   Register cleanup handlers for tempFile and tempScript
//   env = { ...process.env, SSH_ASKPASS: tempScript, SSH_ASKPASS_REQUIRE: 'force',
//           DISPLAY: ':0', SSH_ASKPASS_SSH: '1' }
//   result = spawnSync('ssh-add', [keyPath], { env, stdio: 'pipe' })
//   cleanup: fs.unlinkSync(tempFile), fs.unlinkSync(tempScript) in finally
// If no passphrase:
//   Register cleanup handlers (keyPath may already be in agent)
//   result = spawnSync('ssh-add', [keyPath], { stdio: 'pipe' })
// Return { success: result.status === 0, error: result.stderr?.toString() || null }
// Never throw
```

---

### lib/env.js

```javascript
readEnvFile(repoRoot);
// path.join(repoRoot, '.env')
// Read as BUFFER (not string) to handle binary/UTF-16 .env files correctly (Issue #4).
// If .env does not exist: return null
// Return Buffer | null (caller converts to base64 if needed)

writeEnvFile(projectPath, contents);
// contents is Buffer (Issue #4: never write string to .env)
// fs.writeFileSync(path.join(projectPath, '.env'), contents)
```

---

### lib/files.js

```javascript
validateRelativePath(relPath, projectRoot);
// Reject obvious escape patterns first:
//   Must not start with '/'
//   Must not contain '..' segments
// CRITICAL PATH SAFETY (Issue #5):
// After initial checks, use path.resolve for robust validation:
//   resolved = path.resolve(projectRoot, relPath)
// SYMLINK RESOLUTION (P1-d, P2-i fix): path.resolve normalizes .. but does NOT resolve
// symlinks. If config/ is a symlink to /etc, resolve('config/app.conf') passes the
// startsWith check but the actual path escapes the repo.
//
// Algorithm (walk from projectRoot, not from relPath):
//   let checked = projectRoot
//   for each segment in relPath.split(path.sep):
//     let candidate = path.join(checked, segment)
//     if !fs.existsSync(candidate): break  ← stop at first missing ancestor (restore will mkdir it)
//     let stats = fs.lstatSync(candidate)
//     if stats.isSymbolicLink(): throw Error("Symlinks not allowed in extra file paths")
//     checked = candidate
//   // After loop: checked is the last existing ancestor (may be the file itself if it existed)
//   // Final validation:
//   if resolved === projectRoot: throw Error("Path resolves to repo root")
//   if !resolved.startsWith(projectRoot + path.sep): throw Error("Path escapes root")
//   Return resolved absolute path if valid
//
// Key point: on unpark, parent directories may not exist yet (e.g. certs/ for certs/dev.pem).
// This algorithm stops at the first missing ancestor, so decodeAndWriteFile's own mkdirSync
// handles directory creation. We only reject symlinks that already exist.

encodeFile(filePath);
// Read as BUFFER (not string) to preserve binary content correctly (Issue #4).
// fs.readFileSync(filePath) → buffer.toString('base64')

decodeAndWriteFile(base64Data, relPath, projectRoot);
// resolvedPath = validateRelativePath(relPath, projectRoot)  ← throws if invalid
// fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
// fs.writeFileSync(resolvedPath, Buffer.from(base64Data, 'base64'))

validateFileSizes(relPaths, repoRoot);
// For each path: stat size from path.join(repoRoot, relPath)
// > 500KB (512000 bytes): push to warn[]
// > 1MB (1048576 bytes): push to error[]
// Return { warn, error }

getNextLetter(usedIds);
// usedIds: Set or array of all used IDs (active + retired)
// Generate sequence like Excel columns (base-26, no zero digit):
//   Position 1: A-Z (26 values)
//   Position 2: AA-ZZ (26*26 = 676 values), etc.
// Algorithm:
//   n = 1
//   loop:
//     candidate = toExcelColumn(n)  // A, B...Z, AA, AB...
//     if candidate not in usedIds: return candidate
//     n++
//
// toExcelColumn(n):
//   result = ''
//   while n > 0:
//     n--
//     result = String.fromCharCode(65 + (n % 26)) + result
//     n = Math.floor(n / 26)
//   return result
//
// This produces: A(1) B(2)...Z(26) AA(27) AB(28)...AZ(52) BA(53)...
```

---

## Tech Stack

| Component      | Package                         | Version                               |
| -------------- | ------------------------------- | ------------------------------------- |
| CLI framework  | commander                       | latest                                |
| Prompts        | inquirer                        | ^8.0.0 (CommonJS compatible, not v9+) |
| Git operations | simple-git                      | latest                                |
| Encryption     | Node.js built-in crypto         | —                                     |
| Colors         | ANSI codes directly             | —                                     |
| File glob      | Node.js built-in fs.readdirSync | —                                     |

**No chalk, no colors, no external crypto packages.**

Use inquirer@^8.0.0 specifically — v9+ is ESM-only and breaks with CommonJS require(). Pin the major version: `inquirer@^8.0.0` not `inquirer@latest` (Issue #7).

---

## Key Constraints Reference Table

| Constraint           | Rule                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| Node version         | >= 18, checked at startup in bin/parking.js                                                         |
| Platform             | macOS and Linux only                                                                                |
| Master password      | Never stored. Prompted at start of park/unpark. In memory only.                                     |
| Project names        | `/^[a-zA-Z0-9_-]+$/`, not all-uppercase, no path separators                                         |
| Vault filenames      | `<id>.json` always (A.json, B.json) — never by project name                                         |
| ssh_key_path         | Stored as absolute path (~ expanded at park time)                                                   |
| SSH loading          | Always attempted before clone in unpark. Never abort on SSH failure — warn and continue.            |
| SSH passphrase       | Use SSH_ASKPASS technique, not stdin pipe                                                           |
| Remote resolution    | Resolve actual upstream. If multi-remote and no upstream: ask user to pick. Never hard-code origin. |
| Repo root            | Always `git rev-parse --show-toplevel`. Never cwd.                                                  |
| Clone target         | Always `./<project-name>`. Check exists before password prompt.                                     |
| git commit           | Only when uncommitted files exist. Push-only path when only unpushed commits.                       |
| Push failure in park | Abort, preserve local folder, show clear error.                                                     |
| pushVault()          | Commit then push. If push fails: reset HEAD~1 to undo local commit. Return boolean.                 |
| ensureVaultExists()  | Check `.git` dir exists. If missing/corrupted: wipe and re-clone.                                   |
| forget rollback      | If push fails after local delete: restore JSON and meta.json. No state change.                      |
| Letter gaps          | Permanent. retiredIds in meta.json ensures forgotten IDs never reassigned.                          |
| Letter sequence      | Excel-column style: A-Z, AA-AZ, BA-BZ...ZZ, AAA...                                                  |
| Extra file paths     | Segment-aware path.relative() check — not startsWith(). Must not escape root.                       |
| Setup cmd on unpark  | Show command, ask confirmation before running.                                                      |
| Duplicate names      | Not allowed across active projects. [N] new entry forces rename.                                    |
| ID-shaped names      | Rejected at park time (all-uppercase = reserved for IDs).                                           |
| Offline behavior     | list/status: warn and show cached. park/unpark/forget: require connectivity.                        |
| pushVault first push | Use detected vaultBranch (from init), not hardcoded "main".                                         |
| Windows              | Not supported. State in README. Use rm -rf / Unix paths throughout.                                 |

---

## File Implementation Order

1. `package.json`
2. `bin/parking.js` — Node version check, --version flag, init guard pattern
3. `lib/config.js`
4. `lib/crypto.js` — byte layout comment required
5. `lib/vault.js` — ensureVaultExists with .git check, pushVault with rollback
6. `lib/git.js` — getUpstreamInfo multi-remote algorithm, getUnpushedCommits with fallback
7. `lib/ssh.js` — SSH_ASKPASS technique, duplicate host handling
8. `lib/env.js`
9. `lib/files.js` — segment-aware validateRelativePath, getNextLetter with Excel algorithm
10. `commands/init.js` — rm vault on re-init, detect vaultBranch, create meta.json
11. `commands/list.js` — offline fallback
12. `commands/status.js` — offline fallback
13. `commands/forget.js` — full rollback on push failure
14. `commands/park.js` — full step ordering, name validation first
15. `commands/unpark.js` — directory check before password, SSH_ASKPASS, setup cmd confirmation
16. `README.md`

---

## README Must Include (in this order)

1. **Compatibility:** macOS and Linux only. Node.js v18+.
2. **Installation:** `npm install -g repo-parking`
3. **Before first use:** Go to GitHub → New repository → set Private → do NOT check
   "Initialize with README" → copy SSH remote URL. (Make this a bold warning box.)
4. **Setup:** `parking init`
5. **Master password warning:** "Your master password is never saved anywhere. If you forget
   it, your parked .env files and extra files cannot be recovered. Store it in a password manager."
6. **All commands** with examples
7. **Setup command security note:** "The setup command stored in your vault runs on unpark.
   Since your vault is your private repo, only you control what runs. parking always shows you
   the command and asks for confirmation before running it."
8. **SSH troubleshooting section** — common issues: key not in agent, wrong alias, passphrase errors
9. **Letter permanence note:** "Project letters are permanent identifiers. A forgotten project's
   letter is retired forever and never reassigned. Gaps in the list (A, C, E...) are normal."
10. **Unique names note:** "Project names must be unique. If you need to park two repos with
    the same name, you will be asked to rename one."

---

## Verification Checklist

1. `npm install && npm link` → `parking` command available globally
2. `parking --version` → prints 1.0.0
3. Run on Node 14 → version error, clean exit
4. `parking list` before init → "Run parking init first"
5. `parking init` on fresh machine → clones vault, creates meta.json, saves config
6. `parking init` again → detects existing, asks to re-init, wipes and re-clones
7. `parking park my-app` from repo subdirectory → uses repo root, not subdir
8. `parking park MY-APP` → rejected (all-uppercase = reserved for IDs)
9. `parking park ../evil` → rejected (invalid name)
10. Repo with no remote → clear error, exit before password prompt
11. Repo with multiple remotes, no upstream → shows list, asks user to pick
12. Clean working tree with unpushed commits → push-only path (no commit attempt)
13. Uncommitted files → asks commit message, commits + pushes
14. `parking park` same project twice → duplicate detection, O/N/C options
15. `parking park` with [N] and duplicate name → forced rename prompt
16. Vault push failure → local folder preserved, local vault commit rolled back
17. `parking list` with no internet → cached data shown with warning
18. `parking list` → sorted table, letter gaps shown without explanation needed
19. `parking unpark A` → directory check BEFORE password prompt
20. Clone target exists → [O]verwrite/[C]ancel before password
21. SSH key loaded before clone (check with verbose SSH output)
22. SSH_ASKPASS technique used (not stdin)
23. Setup command shown + confirmation asked before running
24. Wrong master password → "Incorrect master password", clean exit
25. Extra file with absolute path → rejected at park
26. Extra file path `../../etc/passwd` → rejected at park (segment-aware check)
27. Extra file > 1MB → rejected at park
28. `parking forget B` with no internet → rollback, both B.json and meta.json restored
29. Park again after forget → retired letter not reused (check meta.json retiredIds)
30. `parking --help` and `parking <cmd> --help` → correct help text for all commands
