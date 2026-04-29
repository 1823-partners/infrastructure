// `swa-onboard init <app-slug>` — scaffold an existing SWA repo onto the
// cross-app AAD + Beacon proxy paradigm.
//
// What this does, in order:
//   1. Drop staticwebapp.config.json into <app>/public/ (CRA copies public/
//      to build/ at build time). Slug substitutes into the /api/<slug>/*
//      route gate.
//   2. Drop the api/ Functions sub-app (host.json, .npmrc, package.json,
//      <slug>/function.json, <slug>/index.js) — wraps @1823-partners/swa-proxy.
//   3. Edit .github/workflows/azure-static-web-apps-*.yml to set
//      api_location: "api" on the reusable swa-deploy.yml call.
//   4. Emit .app-settings.env.example listing every SWA app setting needed.
//   5. Emit .env.local.example listing the REACT_APP_* vars a dev needs in
//      .env.local for direct-mode `npm start` / `jest` (incl. dev-caller
//      email so the X-Dev-Caller-Email interceptor has something to stamp).
//
// What this does NOT do (intentional, see README):
//   - Modify <app>/src/api/index.js (we don't know the app's API surface).
//     Print explicit migration instructions instead.
//   - Bump @1823-partners/core or run npm install.
//   - Create the AAD app registration or set redirect URIs.
//   - Set Azure app settings (operator does that in Portal).
'use strict';

const fs = require('fs');
const path = require('path');

const {
  slugToAppName,
  copyTreeWithSubstitution,
  copyFileWithSubstitution,
  findSwaWorkflow,
  setApiLocationInWorkflow,
  renderAppSettingsExample,
  renderEnvLocalExample,
} = require('./utils');

async function runInit({ appSlug, appDir, templatesDir, force }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(appSlug)) {
    throw new Error(
      `Invalid slug "${appSlug}". Use lowercase letters, digits, and hyphens (URL-safe form).`,
    );
  }
  if (!fs.existsSync(appDir)) {
    throw new Error(`App directory does not exist: ${appDir}`);
  }
  if (!fs.existsSync(path.join(appDir, 'package.json'))) {
    throw new Error(
      `${appDir} has no package.json — is this the right app directory?`,
    );
  }

  const appName = slugToAppName(appSlug);
  const log = (msg) => process.stdout.write(`  ${msg}\n`);

  process.stdout.write(`\nswa-onboard init ${appSlug}\n`);
  process.stdout.write(`  app dir:    ${appDir}\n`);
  process.stdout.write(`  url slug:   ${appSlug}\n`);
  process.stdout.write(`  APP_NAME:   ${appName}  (Beacon server slug)\n\n`);

  // 1. staticwebapp.config.json → <app>/public/
  const swaConfigSrc = path.join(templatesDir, 'swa-templates', 'staticwebapp.config.json');
  const swaConfigDest = path.join(appDir, 'public', 'staticwebapp.config.json');
  copyFileWithSubstitution({ src: swaConfigSrc, dest: swaConfigDest, slug: appSlug, force });
  log(`wrote ${path.relative(appDir, swaConfigDest)}`);

  // 2. api/ Functions sub-app
  const apiSrc = path.join(templatesDir, 'swa-api-template');
  const apiDest = path.join(appDir, 'api');
  copyTreeWithSubstitution({ src: apiSrc, dest: apiDest, slug: appSlug, force });
  // The template's own README isn't part of the scaffold; remove it so the
  // app's api/ folder stays uncluttered.
  const strayReadme = path.join(apiDest, 'README.md');
  if (fs.existsSync(strayReadme)) fs.unlinkSync(strayReadme);
  log(`wrote ${path.relative(appDir, apiDest)}/ (function.json, index.js, host.json, .npmrc, package.json)`);

  // 3. workflow tweak
  const workflowPath = findSwaWorkflow(appDir);
  if (!workflowPath) {
    log('WARNING: no .github/workflows/azure-static-web-apps-*.yml found — skipping workflow edit.');
    log('         Set api_location: "api" on your swa-deploy.yml call manually.');
  } else {
    const changed = setApiLocationInWorkflow(workflowPath);
    if (changed) {
      log(`patched ${path.relative(appDir, workflowPath)} (api_location: "api")`);
    } else {
      log(`${path.relative(appDir, workflowPath)} already sets api_location — no change`);
    }
  }

  // 4. .app-settings.env.example
  const envExamplePath = path.join(appDir, '.app-settings.env.example');
  if (fs.existsSync(envExamplePath) && !force) {
    log(`${path.relative(appDir, envExamplePath)} exists — leaving alone (re-run with --force to overwrite)`);
  } else {
    fs.writeFileSync(envExamplePath, renderAppSettingsExample({ slug: appSlug, appName }));
    log(`wrote ${path.relative(appDir, envExamplePath)}`);
  }

  // 5. .env.local.example (frontend dev env — gitignored .env.local target)
  const envLocalExamplePath = path.join(appDir, '.env.local.example');
  if (fs.existsSync(envLocalExamplePath) && !force) {
    log(`${path.relative(appDir, envLocalExamplePath)} exists — leaving alone (re-run with --force to overwrite)`);
  } else {
    fs.writeFileSync(envLocalExamplePath, renderEnvLocalExample({ slug: appSlug }));
    log(`wrote ${path.relative(appDir, envLocalExamplePath)}`);
  }

  process.stdout.write(
    [
      '',
      'Next steps (operator):',
      `  1. Set the values from .app-settings.env.example in Azure Portal → SWA →`,
      `     Configuration → Application settings on BOTH Production and Preview.`,
      `  2. Add ${appSlug}.<custom-domain>/.auth/login/aad/callback to the shared`,
      `     1823 SWA AAD app registration's redirect URIs (Authentication → Web).`,
      `  3. Migrate <app>/src/api/index.js to @1823-partners/core's createAppTransport:`,
      `       import { createAppTransport } from '@1823-partners/core';`,
      `       const api = createAppTransport({ axios, appName: '${appSlug}', clientToken: CLIENT_TOKEN });`,
      `     (proxy in prod, direct in dev/test — picked from NODE_ENV).`,
      `  4. Bump @1823-partners/core to ^1.17.0 or later in <app>/package.json,`,
      `     then \`npm install\` to update package-lock.json.`,
      `  5. Commit, push to main → preview deploy, then cut a release-X.Y.Z branch`,
      `     for production.`,
      `  6. Run: swa-onboard verify https://<your-preview-host> --app-slug ${appSlug}`,
      '',
    ].join('\n'),
  );
}

module.exports = { runInit };
