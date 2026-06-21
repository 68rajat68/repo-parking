# Repository Guidelines

## Project Structure & Module Organization

This is a Node.js CLI package for the `parking` command. The executable entrypoint is `bin/parking.js`, which wires Commander commands and performs the Node version check. Command handlers live in `commands/` (`park.js`, `unpark.js`, `list.js`, etc.). Shared implementation code lives in `lib/`, including vault storage, encryption, git operations, config, SSH parsing, file helpers, and spinner utilities. Public usage documentation is in `README.md`; planning and review notes are in `PLAN.md` and `PROJECT_FLOW_AND_REVIEW.md`.

## Build, Test, and Development Commands

- `npm install`: install runtime dependencies from `package-lock.json`.
- `node bin/parking.js -h`: run the CLI locally and inspect available commands.
- `node bin/parking.js <command>`: exercise a command without installing globally, for example `node bin/parking.js list`.
- `npm link`: optional local global install so `parking` resolves to this checkout.

There is no build step; the package runs directly on Node.js v18+.

## Coding Style & Naming Conventions

Use CommonJS modules (`require`, `module.exports`) and keep files ASCII unless an existing file already requires otherwise. Follow the current style: two-space indentation, semicolons, double quotes for strings, and trailing commas in multiline calls or object literals where already used. Name command modules after CLI commands with kebab-case filenames, such as `change-password.js`. Use small helper functions in `lib/` when logic is shared across commands.

## Testing Guidelines

No automated test framework or `npm test` script is currently configured. For changes, run targeted manual checks with `node bin/parking.js -h` and the affected command paths. Be careful with commands that touch real repositories, vault remotes, `~/.repo-parkingrc`, or encrypted data; prefer disposable local repos and test vaults. If adding tests, place them in a new `test/` or `tests/` directory and add an explicit `npm test` script.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries such as `Bump version to 1.1.1`, `Clarify global installation requirement (-g flag)`, and `Fix version to read from package.json dynamically`. Keep commit subjects focused on one change. Pull requests should describe the user-visible behavior, list manual verification performed, call out security or data-loss implications, and include screenshots or terminal output when CLI messaging changes.

## Security & Configuration Tips

Do not commit vault contents, passwords, recovery keys, private SSH paths, or real `.env` data. Treat changes in `lib/crypto.js`, `lib/vault.js`, `lib/git.js`, and destructive file-removal flows as high risk and verify rollback/error behavior carefully.
