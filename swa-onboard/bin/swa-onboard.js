#!/usr/bin/env node
// swa-onboard CLI entry. Dispatches to subcommands. Keep this file thin —
// real work happens in src/.
'use strict';

const path = require('path');
const { runInit } = require('../src/init');
const { runVerify } = require('../src/verify');

const USAGE = `Usage:
  swa-onboard init <app-slug> [--app-dir <path>] [--force]
  swa-onboard verify <hostname> [--app-dir <path>] [--app-slug <slug>]

Subcommands:
  init     Scaffold staticwebapp.config.json + api/ proxy + workflow tweak
           + .app-settings.env.example into the target app repo.
  verify   Post-deploy smoke check: /.auth/me unmasked email, /api/<slug>/*
           reachable, build/ free of bundled Beacon tokens, route gate
           consistent with APP_NAME convention.

Options:
  --app-dir <path>   Path to the target app's repo root. Defaults to cwd.
  --app-slug <slug>  Slug to verify against (defaults to inferred from
                     staticwebapp.config.json).
  --force            Overwrite existing scaffolded files.

Examples:
  cd ../blotter && swa-onboard init blotter
  swa-onboard verify https://blotter.1823.partners
`;

function parseArgs(argv) {
  const [, , subcommand, positional, ...rest] = argv;
  const flags = {};
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    if (arg === '--app-dir' || arg === '--app-slug') {
      flags[arg.slice(2)] = rest[i + 1];
      i += 2;
    } else if (arg === '--force') {
      flags.force = true;
      i += 1;
    } else {
      i += 1;
    }
  }
  return { subcommand, positional, flags };
}

async function main() {
  const { subcommand, positional, flags } = parseArgs(process.argv);

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(USAGE);
    process.exit(subcommand ? 0 : 1);
  }

  const appDir = path.resolve(flags['app-dir'] || process.cwd());
  const templatesDir = path.resolve(__dirname, '..', '..');

  try {
    if (subcommand === 'init') {
      if (!positional) {
        process.stderr.write('init: missing <app-slug> argument\n\n' + USAGE);
        process.exit(1);
      }
      await runInit({ appSlug: positional, appDir, templatesDir, force: !!flags.force });
    } else if (subcommand === 'verify') {
      if (!positional) {
        process.stderr.write('verify: missing <hostname> argument\n\n' + USAGE);
        process.exit(1);
      }
      await runVerify({
        hostname: positional,
        appDir,
        appSlug: flags['app-slug'],
      });
    } else {
      process.stderr.write(`Unknown subcommand: ${subcommand}\n\n` + USAGE);
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`\nswa-onboard ${subcommand} failed: ${err.message}\n`);
    if (process.env.SWA_ONBOARD_DEBUG) {
      process.stderr.write(err.stack + '\n');
    }
    process.exit(1);
  }
}

main();
