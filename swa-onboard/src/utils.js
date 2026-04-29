// Shared helpers for swa-onboard. Kept dependency-free aside from js-yaml.
'use strict';

const fs = require('fs');
const path = require('path');

// Convert a URL slug (hyphenated) to the Beacon APP_NAME (underscored).
// Beacon route is `pam/<APP_NAME>/...` where APP_NAME matches the server
// filename — bob_dashboard, not bob-dashboard. We default APP_NAME to the
// underscored form; the operator can override if the server is named
// differently.
function slugToAppName(slug) {
  return slug.replace(/-/g, '_');
}

// Recursively copy a directory, substituting `__APP__` in file contents AND
// path segments with the provided slug. Throws if a target file exists and
// `force` is not set.
function copyTreeWithSubstitution({ src, dest, slug, force }) {
  if (!fs.existsSync(src)) {
    throw new Error(`Source path does not exist: ${src}`);
  }
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const renamedName = entry.name.replace(/__APP__/g, slug);
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, renamedName);
    if (entry.isDirectory()) {
      copyTreeWithSubstitution({ src: srcPath, dest: destPath, slug, force });
    } else if (entry.isFile()) {
      if (fs.existsSync(destPath) && !force) {
        throw new Error(
          `Refusing to overwrite ${destPath}. Re-run with --force to replace.`,
        );
      }
      const contents = fs.readFileSync(srcPath, 'utf8').replace(/__APP__/g, slug);
      fs.writeFileSync(destPath, contents);
    }
  }
}

// Copy a single file with `__APP__` substitution, with the same overwrite
// guard.
function copyFileWithSubstitution({ src, dest, slug, force }) {
  if (fs.existsSync(dest) && !force) {
    throw new Error(
      `Refusing to overwrite ${dest}. Re-run with --force to replace.`,
    );
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const contents = fs.readFileSync(src, 'utf8').replace(/__APP__/g, slug);
  fs.writeFileSync(dest, contents);
}

// Find the SWA workflow file in `<appDir>/.github/workflows/`. Returns the
// absolute path or null. We match `azure-static-web-apps-*.yml` since that's
// the convention emitted by Azure's wizard for every existing 1823 SWA.
function findSwaWorkflow(appDir) {
  const workflowDir = path.join(appDir, '.github', 'workflows');
  if (!fs.existsSync(workflowDir)) return null;
  const matches = fs
    .readdirSync(workflowDir)
    .filter((f) => /^azure-static-web-apps-.*\.ya?ml$/.test(f));
  if (matches.length === 0) return null;
  return path.join(workflowDir, matches[0]);
}

// Edit the consumer SWA workflow YAML so it sets `api_location: "api"` on
// the reusable swa-deploy.yml call. Idempotent: re-running on an already-
// configured workflow is a no-op.
function setApiLocationInWorkflow(workflowPath) {
  const yaml = require('js-yaml');
  const original = fs.readFileSync(workflowPath, 'utf8');
  const doc = yaml.load(original);
  if (!doc || !doc.jobs) {
    throw new Error(
      `Workflow at ${workflowPath} has no \`jobs:\` block — is this a SWA workflow?`,
    );
  }
  let changed = false;
  for (const jobName of Object.keys(doc.jobs)) {
    const job = doc.jobs[jobName];
    if (!job || typeof job.uses !== 'string') continue;
    if (!job.uses.includes('infrastructure/.github/workflows/swa-deploy.yml')) continue;
    job.with = job.with || {};
    if (job.with.api_location !== 'api') {
      job.with.api_location = 'api';
      changed = true;
    }
  }
  if (!changed) return false;
  const updated = yaml.dump(doc, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(workflowPath, updated);
  return true;
}

// Render the `.app-settings.env.example` body. Lists every SWA app setting
// the proxy + AAD config require, with sane defaults. The operator copies
// the values into Azure Portal → Configuration → Application settings on
// BOTH Production and Preview environments.
function renderAppSettingsExample({ slug, appName }) {
  return [
    '# SWA Application Settings — set these on BOTH Production and Preview',
    '# environments in Azure Portal → Configuration. Preview does NOT inherit.',
    '#',
    '# Created by swa-onboard. Safe to commit (no secrets here, just keys).',
    '',
    '# --- AAD identity (shared across all 1823 SWAs) ---',
    '# Tenant id is referenced inline in staticwebapp.config.json; client',
    '# id + secret are pulled from these app settings by the SWA edge.',
    'AAD_CLIENT_ID=<shared 1823 SWA AAD client id>',
    'AAD_CLIENT_SECRET=<shared 1823 SWA AAD client secret>',
    '',
    '# --- Beacon proxy (read by api/<slug>/index.js via @1823-partners/swa-proxy) ---',
    'BEACON_URL=https://pam.wsq.io',
    `# DB_ENV: prod | prod_snap | dev. Picks the Beacon environment the proxy hits.`,
    'DB_ENV=prod',
    `# APP_NAME is the Beacon server slug — must match pam-master/pam/servers/<APP_NAME>_server.py`,
    `# (underscore form). For ${slug} the default is ${appName}; override if your server is named differently.`,
    `APP_NAME=${appName}`,
    '',
    '# --- Beacon credentials (formerly bundled JSON tokens; now server-side) ---',
    'BEACON_USER_TOKEN_ID=<service user token id>',
    'BEACON_USER_TOKEN_SECRET=<service user token secret>',
    `BEACON_APP_TOKEN_ID=<per-app token id for ${appName}>`,
    `BEACON_APP_TOKEN_SECRET=<per-app token secret for ${appName}>`,
    '',
    '# --- GH Packages (so Oryx can install @1823-partners/swa-proxy at deploy) ---',
    '# A PAT with read:packages scope. Same value as the workflow uses.',
    'NODE_AUTH_TOKEN=<github PAT with read:packages>',
    '',
  ].join('\n');
}

module.exports = {
  slugToAppName,
  copyTreeWithSubstitution,
  copyFileWithSubstitution,
  findSwaWorkflow,
  setApiLocationInWorkflow,
  renderAppSettingsExample,
};
