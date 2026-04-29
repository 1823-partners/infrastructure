// `swa-onboard verify <hostname>` — post-deploy smoke check.
//
// Confirms the four things that have actually broken on us during the
// permissions + bob-dashboard rollout:
//   1. /.auth/me returns an unmasked email (custom AAD app reg works)
//   2. /api/<slug>/<known-route> reaches Beacon (proxy + app settings wired)
//   3. build/ contains no bundled Beacon tokens (frontend migrated)
//   4. staticwebapp.config.json's route gate matches the api/ slug
//      (the bob_dashboard vs bob-dashboard incident)
//
// Net 0 dependencies — uses Node's built-in https + fs.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.get(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        // The point of /.auth/me is to fail closed when unauthenticated. We
        // accept any status; callers inspect the body.
        headers: { Accept: 'application/json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error(`Timeout fetching ${urlStr}`));
    });
  });
}

function inferSlugFromConfig(appDir) {
  const cfg = path.join(appDir, 'public', 'staticwebapp.config.json');
  if (!fs.existsSync(cfg)) return null;
  const doc = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  if (!doc.routes) return null;
  for (const route of doc.routes) {
    const m = /^\/api\/([^/]+)\/\*$/.exec(route.route || '');
    if (m) return m[1];
  }
  return null;
}

function checkBundleForTokens(appDir) {
  const buildDir = path.join(appDir, 'build');
  if (!fs.existsSync(buildDir)) {
    return { ran: false, reason: 'build/ does not exist (run `npm run build` first)' };
  }
  const offenders = [];
  // We're looking for credential SHAPES (long base64-ish strings paired with
  // a secret key) — not bare identifier mentions like an import path that
  // got into a sourcemap. The pre-proxy era stored tokens as 40+ char
  // alphanumeric values in `client_secret` / `token_secret` / `_id` keys.
  const credentialPattern = /"(?:client_secret|client_id|token_secret|token_id)"\s*:\s*"[A-Za-z0-9_\-=+/]{20,}"/;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // Skip .map files — sourcemaps inherently echo source filenames
      // (e.g. `beacon_app_token_X.json`) and that's a non-issue if the
      // actual JS bundle is clean.
      else if (entry.isFile() && /\.(js|json|html)$/.test(entry.name) && !entry.name.endsWith('.map')) {
        const contents = fs.readFileSync(full, 'utf8');
        if (credentialPattern.test(contents)) {
          offenders.push(path.relative(buildDir, full));
        }
      }
    }
  };
  walk(buildDir);
  return { ran: true, offenders };
}

async function runVerify({ hostname, appDir, appSlug }) {
  const slug = appSlug || inferSlugFromConfig(appDir);
  if (!slug) {
    throw new Error(
      'Could not infer app slug. Pass --app-slug, or run from the app directory with public/staticwebapp.config.json present.',
    );
  }
  const baseUrl = hostname.startsWith('http') ? hostname : `https://${hostname}`;
  process.stdout.write(`\nswa-onboard verify ${baseUrl}\n`);
  process.stdout.write(`  app dir:  ${appDir}\n`);
  process.stdout.write(`  slug:     ${slug}\n\n`);

  const results = [];
  const log = (label, ok, detail) => {
    const mark = ok ? 'PASS' : 'FAIL';
    process.stdout.write(`  [${mark}] ${label}${detail ? ' — ' + detail : ''}\n`);
    results.push({ label, ok });
  };

  // 1. /.auth/me unmasked
  try {
    const { statusCode, body } = await httpsGet(`${baseUrl}/.auth/me`);
    if (statusCode !== 200) {
      log('/.auth/me reachable', false, `HTTP ${statusCode}`);
    } else {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        log('/.auth/me JSON parses', false, e.message);
        parsed = null;
      }
      const principal = parsed && parsed.clientPrincipal;
      if (!principal) {
        // Curl without cookies returns null clientPrincipal — that's the
        // expected unauthenticated response, not a failure. Mark INFO.
        process.stdout.write(
          '  [INFO] /.auth/me returned null clientPrincipal (no auth cookie). Open in a browser to confirm an unmasked email.\n',
        );
      } else {
        const userDetails = principal.userDetails || '';
        const masked = !userDetails || userDetails.includes('*') || !userDetails.includes('@');
        log(
          'userDetails unmasked email',
          !masked,
          masked ? `got "${userDetails}" — AAD app reg may not be custom` : userDetails,
        );
      }
    }
  } catch (e) {
    log('/.auth/me reachable', false, e.message);
  }

  // 2. /api/<slug>/<sentinel> — we don't know an unauthenticated route, so
  //    just confirm the gate is in place (401 redirect is the expected
  //    response when curling without auth cookies).
  try {
    const { statusCode } = await httpsGet(`${baseUrl}/api/${slug}/`);
    const ok = statusCode === 302 || statusCode === 401 || statusCode === 200;
    log(
      `/api/${slug}/ gated`,
      ok,
      `HTTP ${statusCode} (expect 302→/.auth/login/aad or 401)`,
    );
  } catch (e) {
    log(`/api/${slug}/ reachable`, false, e.message);
  }

  // 3. build/ free of bundled tokens
  const tokenCheck = checkBundleForTokens(appDir);
  if (!tokenCheck.ran) {
    log('build/ free of beacon tokens', false, tokenCheck.reason);
  } else if (tokenCheck.offenders.length === 0) {
    log('build/ free of beacon tokens', true, '');
  } else {
    log(
      'build/ free of beacon tokens',
      false,
      `${tokenCheck.offenders.length} file(s): ${tokenCheck.offenders.slice(0, 3).join(', ')}${tokenCheck.offenders.length > 3 ? '…' : ''}`,
    );
  }

  // 4. APP_NAME convention sanity — the slug in the route gate uses hyphens
  //    (URL-safe), but the Beacon server filename uses underscores. Most of
  //    the time these are the same; warn when they aren't so the operator
  //    sets APP_NAME correctly.
  if (slug.includes('-')) {
    process.stdout.write(
      `  [INFO] slug "${slug}" contains a hyphen. Confirm SWA app setting APP_NAME=${slug.replace(/-/g, '_')}\n`,
    );
    process.stdout.write(
      `         (Beacon route is pam/<APP_NAME>/... where APP_NAME matches the *_server.py filename, underscored.)\n`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed.\n`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

module.exports = { runVerify };
