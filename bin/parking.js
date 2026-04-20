#!/usr/bin/env node

const { loadConfig } = require('../lib/config');

// 1. Node version check
const [major] = process.version.replace('v', '').split('.').map(Number);
if (major < 18) {
  console.error(
    'repo-parking requires Node.js v18+. Current: ' + process.version
  );
  process.exit(1);
}

const { program } = require('commander');
const path = require('path');
const fs = require('fs');

// 3. COMMANDER EXIT OVERRIDE
// Commander calls process.exit() automatically on errors. This prevents rollback
// logic in pushVault from running. Fix: add exitOverride() BEFORE adding commands.
program.exitOverride();

// Load all command files
const initCommand = require('../commands/init');
const listCommand = require('../commands/list');
const statusCommand = require('../commands/status');
const forgetCommand = require('../commands/forget');
const parkCommand = require('../commands/park');
const unparkCommand = require('../commands/unpark');
const changePasswordCommand = require('../commands/change-password');
const recoverCommand = require('../commands/recover');

program.version('1.0.0', '-v, --version', 'Print version number');

program
  .command('init')
  .description('Initialize the vault repository')
  .action(initCommand);

program
  .command('list')
  .description('List all parked projects')
  .action(() => {
    const config = loadConfig();
    if (!config) {
      console.error('Not initialized. Run `parking init` first.');
      process.exit(1);
    }
    listCommand();
  });

program
  .command('status <name_or_letter>')
  .description('Show details of a parked project')
  .action((nameOrLetter) => {
    const config = loadConfig();
    if (!config) {
      console.error('Not initialized. Run `parking init` first.');
      process.exit(1);
    }
    statusCommand(nameOrLetter);
  });

program
  .command('forget <name_or_letter>')
  .description('Remove a project from the vault (does not delete the remote repo)')
  .action((nameOrLetter) => {
    const config = loadConfig();
    if (!config) {
      console.error('Not initialized. Run `parking init` first.');
      process.exit(1);
    }
    forgetCommand(nameOrLetter);
  });

program
  .command('park <name>')
  .description('Park a git repository')
  .action((name) => {
    const config = loadConfig();
    if (!config) {
      console.error('Not initialized. Run `parking init` first.');
      process.exit(1);
    }
    parkCommand(name);
  });

program
  .command('unpark <name_or_letter>')
  .description('Restore a parked repository')
  .action((nameOrLetter) => {
    const config = loadConfig();
    if (!config) {
      console.error('Not initialized. Run `parking init` first.');
      process.exit(1);
    }
    unparkCommand(nameOrLetter);
  });

program
  .command('change-password')
  .description('Change your master password without re-encrypting vault data')
  .action(() => {
    const config = loadConfig();
    if (!config) {
      console.error('Not initialized. Run `parking init` first.');
      process.exit(1);
    }
    changePasswordCommand();
  });

program
  .command('recover')
  .description('Reset master password using your recovery key')
  .action(() => {
    const config = loadConfig();
    if (!config) {
      console.error('Not initialized. Run `parking init` first.');
      process.exit(1);
    }
    recoverCommand();
  });

try {
  program.parse(process.argv);
} catch (err) {
  if (err.code === 'commander.version') {
    process.exit(0);
  }
  if (err.code === 'commander.helpDisplayed') {
    process.exit(0);
  }
  if (err.code === 'commander.unknownCommand') {
    const unknownCmd = err.commandName || process.argv[2] || 'unknown';
    console.error("error: unknown command '" + unknownCmd + "'");
    console.error("Run 'parking -h' to see valid commands.");
    process.exit(1);
  }
  throw err;
}
