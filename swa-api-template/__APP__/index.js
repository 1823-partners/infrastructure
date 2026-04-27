// Generic SWA Function proxy → Beacon.
//
// The SWA edge validates the caller's AAD token and injects the signed
// ``x-ms-client-principal`` header before this Function ever runs. We forward
// it on the outbound hop so Beacon can read the verified caller identity.
// Beacon service auth (user_token + app_token) lives in SWA app settings so
// the React bundle no longer ships any Beacon credentials.
//
// Adoption checklist (also see ../README.md):
//   1. Copy this directory tree into <app>/api/.
//   2. Rename __APP__/ to your app's URL slug (must match the
//      staticwebapp.config.json route and the frontend's API base path).
//   3. Set api_location: "api" in the consumer workflow.
//   4. Configure the SWA app settings listed below on BOTH the production
//      and preview environments.
//
// Required SWA app settings (Configuration → Application settings):
//   BEACON_URL              e.g. https://pam.wsq.io
//   DB_ENV                  prod | prod_snap | dev
//   APP_NAME                Beacon URL slug for this app, e.g. "blotter"
//                           — must match pam-master/pam/servers/<app>_server.py
//   BEACON_USER_TOKEN_ID    service user token id
//   BEACON_USER_TOKEN_SECRET
//   BEACON_APP_TOKEN_ID     per-app token id
//   BEACON_APP_TOKEN_SECRET

const fetch = require('node-fetch');

const {
  BEACON_URL,
  DB_ENV,
  APP_NAME,
  BEACON_USER_TOKEN_ID,
  BEACON_USER_TOKEN_SECRET,
  BEACON_APP_TOKEN_ID,
  BEACON_APP_TOKEN_SECRET,
} = process.env;

// Cache the Beacon bearer for ~55 min. Acquiring it is the expensive part of
// each request; callers get one handshake per cold Function instance + refresh.
let cachedToken = null;
let cachedUntil = 0;

async function getBeaconToken() {
  const now = Date.now();
  if (cachedToken && now < cachedUntil) return cachedToken;

  const r = await fetch(`${BEACON_URL}/login/authtoken`, {
    headers: {
      Authorization:
        `Token ${BEACON_USER_TOKEN_ID},${BEACON_USER_TOKEN_SECRET},` +
        `${BEACON_APP_TOKEN_ID},${BEACON_APP_TOKEN_SECRET}`,
    },
  });
  const body = await r.text();
  if (!r.ok) {
    throw new Error(`beacon authtoken ${r.status}: ${body.slice(0, 200)}`);
  }
  // Beacon returns the raw JWT as the response body (not wrapped in JSON).
  // Strip surrounding whitespace/quotes in case a future server build wraps it.
  cachedToken = body.trim().replace(/^"|"$/g, '');
  // Beacon tokens are 60-min; refresh at 55.
  cachedUntil = now + 55 * 60 * 1000;
  return cachedToken;
}

module.exports = async function (context, req) {
  try {
    if (!BEACON_URL || !DB_ENV || !APP_NAME) {
      context.res = {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: { error: 'proxy_misconfigured' },
      };
      return;
    }

    const subpath = (req.params && req.params.path) || '';
    const qs = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
    const target = `${BEACON_URL}/r/${DB_ENV}/pam/${APP_NAME}/${subpath}${qs}`;

    const beaconToken = await getBeaconToken();

    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${beaconToken}`,
        // SWA injects this on the inbound hop; we relay it so the Beacon
        // server's caller_email() helper sees the signed identity.
        'x-ms-client-principal': req.headers['x-ms-client-principal'] || '',
      },
      body: ['GET', 'HEAD'].includes(req.method)
        ? undefined
        : JSON.stringify(req.body ?? {}),
    });

    const text = await upstream.text();
    context.res = {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
      body: text,
    };
  } catch (err) {
    context.log.error(`${APP_NAME || '?'} proxy error:`, err.message);
    context.res = {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
      body: { error: 'proxy_error', detail: err.message },
    };
  }
};
