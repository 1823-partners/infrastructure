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
//   - Create the AAD app registration or set redirect URIs.
//   - Set Azure app settings (operator does that in Portal).
//
// What this DOES do (now):
//   - Bump @1823-partners/core to MIN_CORE_VERSION in <app>/package.json
//     if it is below that floor (createAppTransport landed in 1.18.0; we
//     pin to 1.19.1 because that's the version that fixed direct-mode
//     env-var fallback). Re-runs are no-ops.
//   - Run a clean install (`rm -rf node_modules/@1823-partners && npm i`)
//     so the bumped version actually replaces the stale cached one. Plain
//     `npm install` after a caret-bump is a no-op when the cached version
//     already satisfies the new range.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Minimum @1823-partners/core that exposes `createAppTransport` with the
// env-driven direct/proxy switch.
const MIN_CORE_VERSION = '1.19.1';

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

  // 6. Bump @1823-partners/core in package.json (if below floor) and
  //    refresh the npm install. We bust the @1823-partners/* cache before
  //    `npm install` because a caret-bump alone is a no-op when the stale
  //    cached version already satisfies the new range.
  const bumped = bumpCoreInPackageJson(appDir);
  if (bumped) {
    log(`bumped @1823-partners/core to ^${MIN_CORE_VERSION} in package.json`);
  } else {
    log(`@1823-partners/core already at >= ${MIN_CORE_VERSION} — no bump needed`);
  }
  refreshNodeModules(appDir, log);

  process.stdout.write(
    [
      '',
      'Next steps (operator):',
      `  1. Set the values from .app-settings.env.example in Azure Portal → SWA →`,
      `     Configuration → Application settings on BOTH Production and Preview.`,
      `  2. Add ${appSlug}.<custom-domain>/.auth/login/aad/callback to the shared`,
      `     1823 SWA AAD app registration's redirect URIs (Authentication → Web).`,
      `  3. Migrate <app>/src/api/index.js to @1823-partners/core's createAppTransport:`,
      `       import axios from 'axios';`,
      `       import { createAppTransport } from '@1823-partners/core';`,
      `       const api = createAppTransport({ axios, appName: '${appSlug}' });`,
      `     (proxy in prod, direct in dev/test — picked from NODE_ENV; the`,
      `     bundled beacon_user_token.json / beacon_app_token_*.json files`,
      `     can be deleted along with their imports).`,
      `  4. Commit, push to main → preview deploy, then cut a release-X.Y.Z branch`,
      `     for production.`,
      `  5. Run: swa-onboard verify https://<your-preview-host> --app-slug ${appSlug}`,
      '',
    ].join('\n'),
  );
}

// Bump @1823-partners/core to ^MIN_CORE_VERSION if the existing caret/tilde
// range is below the floor. Returns true if the file was rewritten.
function bumpCoreInPackageJson(appDir) {
  const pkgPath = path.join(appDir, 'package.json');
  const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw);
  const target = `^${MIN_CORE_VERSION}`;
  const dep = (pkg.dependencies && pkg.dependencies['@1823-partners/core']) || null;
  if (!dep) {
    // Not a consumer of core — leave alone.
    return false;
  }
  // Strip leading range operators to get a plain semver to compare.
  const m = dep.match(/^[\^~>=]*\s*(\d+)\.(\d+)\.(\d+)/);
  if (m) {
    const [maj, min, patch] = m.slice(1).map(Number);
    const [tMaj, tMin, tPatch] = MIN_CORE_VERSION.split('.').map(Number);
    const cmp =
      maj !== tMaj ? maj - tMaj : min !== tMin ? min - tMin : patch - tPatch;
    if (cmp >= 0) return false;
  }
  pkg.dependencies['@1823-partners/core'] = target;
  // Preserve trailing newline if present.
  const trailing = pkgRaw.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + trailing);
  return true;
}

// Bust the @1823-partners/* cache and run `npm install`. This is the fix
// for the silent no-op where a caret-bump is satisfied by the already-
// cached version, leaving node_modules out of date.
function refreshNodeModules(appDir, log) {
  const scopedDir = path.join(appDir, 'node_modules', '@1823-partners');
  if (fs.existsSync(scopedDir)) {
    fs.rmSync(scopedDir, { recursive: true, force: true });
    log(`cleared node_modules/@1823-partners (cache-bust)`);
  }
  log(`running \`npm install\`…`);
  try {
    execFileSync('npm', ['install'], { cwd: appDir, stdio: 'inherit' });
  } catch (err) {
    throw new Error(
      `\`npm install\` failed in ${appDir}. Check that NODE_AUTH_TOKEN is set ` +
        `(GitHub Packages PAT with read:packages) and re-run.`,
    );
  }
}

module.exports = { runInit };
