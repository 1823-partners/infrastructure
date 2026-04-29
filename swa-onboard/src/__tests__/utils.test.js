// node --test runner. No external test deps.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  slugToAppName,
  copyTreeWithSubstitution,
  setApiLocationInWorkflow,
  renderAppSettingsExample,
  renderEnvLocalExample,
} = require('../utils');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('slugToAppName converts hyphens to underscores', () => {
  assert.equal(slugToAppName('bob-dashboard'), 'bob_dashboard');
  assert.equal(slugToAppName('blotter'), 'blotter');
  assert.equal(slugToAppName('a-b-c'), 'a_b_c');
});

test('copyTreeWithSubstitution renames __APP__ in paths and contents', () => {
  const src = tmpDir('swa-onboard-src-');
  const dest = tmpDir('swa-onboard-dest-');
  fs.mkdirSync(path.join(src, '__APP__'));
  fs.writeFileSync(
    path.join(src, '__APP__', 'function.json'),
    '{"route":"__APP__/{*path}"}',
  );
  fs.writeFileSync(path.join(src, 'package.json'), '{"name":"__APP__-api"}');

  copyTreeWithSubstitution({ src, dest, slug: 'blotter', force: false });

  assert.equal(
    fs.readFileSync(path.join(dest, 'blotter', 'function.json'), 'utf8'),
    '{"route":"blotter/{*path}"}',
  );
  assert.equal(
    fs.readFileSync(path.join(dest, 'package.json'), 'utf8'),
    '{"name":"blotter-api"}',
  );
});

test('copyTreeWithSubstitution refuses to overwrite without --force', () => {
  const src = tmpDir('swa-onboard-src2-');
  const dest = tmpDir('swa-onboard-dest2-');
  fs.writeFileSync(path.join(src, 'host.json'), '{}');
  fs.writeFileSync(path.join(dest, 'host.json'), '{"existing": true}');

  assert.throws(
    () => copyTreeWithSubstitution({ src, dest, slug: 'x', force: false }),
    /Refusing to overwrite/,
  );
  // With force=true, it goes through.
  copyTreeWithSubstitution({ src, dest, slug: 'x', force: true });
  assert.equal(fs.readFileSync(path.join(dest, 'host.json'), 'utf8'), '{}');
});

test('setApiLocationInWorkflow sets api_location idempotently', () => {
  const dir = tmpDir('swa-onboard-wf-');
  const wf = path.join(dir, 'azure-static-web-apps-test.yml');
  fs.writeFileSync(
    wf,
    [
      'name: Azure Static Web Apps CI/CD',
      'on:',
      '  push:',
      '    branches: [main]',
      'jobs:',
      '  deploy:',
      '    uses: 1823-partners/infrastructure/.github/workflows/swa-deploy.yml@main',
      '    with:',
      '      azure_token_secret_name: AZURE_TOKEN',
      '    secrets: inherit',
      '',
    ].join('\n'),
  );

  const changed1 = setApiLocationInWorkflow(wf);
  assert.equal(changed1, true);
  const updated = fs.readFileSync(wf, 'utf8');
  assert.match(updated, /api_location: api/);
  assert.match(updated, /azure_token_secret_name: AZURE_TOKEN/);

  // Re-run: no change.
  const changed2 = setApiLocationInWorkflow(wf);
  assert.equal(changed2, false);
});

test('setApiLocationInWorkflow rejects non-SWA workflow', () => {
  const dir = tmpDir('swa-onboard-wf2-');
  const wf = path.join(dir, 'broken.yml');
  fs.writeFileSync(wf, 'name: nope\n');
  assert.throws(() => setApiLocationInWorkflow(wf), /no `jobs:` block/);
});

test('renderEnvLocalExample includes REACT_APP_DEV_USER and beacon vars', () => {
  // Devs need both the direct-mode Beacon credentials and the dev-caller
  // email var so the X-Dev-Caller-Email interceptor in @1823-partners/core
  // has something to stamp on outgoing requests when running on localhost.
  const out = renderEnvLocalExample({ slug: 'bob-dashboard' });
  for (const key of [
    'REACT_APP_BEACON_URL',
    'REACT_APP_DB_ENV',
    'REACT_APP_BEACON_USER_TOKEN_ID',
    'REACT_APP_BEACON_USER_TOKEN_SECRET',
    'REACT_APP_BEACON_APP_TOKEN_ID',
    'REACT_APP_BEACON_APP_TOKEN_SECRET',
    'REACT_APP_DEV_USER',
  ]) {
    assert.match(out, new RegExp(key));
  }
  // Slug substitutes into the comment pointing at api/<slug>/index.js.
  assert.match(out, /api\/bob-dashboard\/index\.js/);
});

test('renderAppSettingsExample includes all required keys', () => {
  const out = renderAppSettingsExample({ slug: 'bob-dashboard', appName: 'bob_dashboard' });
  for (const key of [
    'AAD_CLIENT_ID',
    'AAD_CLIENT_SECRET',
    'BEACON_URL',
    'DB_ENV',
    'APP_NAME=bob_dashboard',
    'BEACON_USER_TOKEN_ID',
    'BEACON_USER_TOKEN_SECRET',
    'BEACON_APP_TOKEN_ID',
    'BEACON_APP_TOKEN_SECRET',
    'NODE_AUTH_TOKEN',
  ]) {
    assert.match(out, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
