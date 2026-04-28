# SWA API proxy template

Drop-in Function proxy that lets a 1823 SWA forward authenticated calls
to Beacon **without bundling Beacon credentials in the React build**.
Beacon's `user_token` and `app_token` move into SWA app settings; the
browser only ever talks to `/api/<app>/*` on its own origin.

The proxy logic lives in [`@1823-partners/swa-proxy`](https://github.com/1823-partners/swa-proxy);
this template is the per-app skeleton (host.json + function.json + a 4-line
`index.js` wrapper).

## What it does

```
React bundle  →  /api/<app>/*  →  SWA Function (this proxy)  →  Beacon
                                  • adds x-ms-client-principal (signed by SWA)
                                  • adds Bearer <jwt from /login/authtoken>
```

The SWA edge enforces auth (`/api/<app>/*` is gated to `authenticated`
in `staticwebapp.config.json`) and signs the `x-ms-client-principal`
blob, which `@1823-partners/swa-proxy` relays so Beacon can read the
verified caller identity via `pam.servers.utils.auth.caller_email`.

The proxy caches the Beacon bearer for ~55 min so each cold Function
instance pays exactly one handshake.

## Adoption checklist (per app)

1. **Copy the template into your app's repo:**
   ```bash
   cp -r infrastructure/swa-api-template <your-app>/api
   ```
2. **Rename the function directory** from `__APP__` to your app's URL
   slug. The slug must match three things:
   - the directory name (`<app>/api/<slug>/`)
   - the `route` in `<slug>/function.json` (`"<slug>/{*path}"`)
   - the route gate in your `staticwebapp.config.json`
     (`/api/<slug>/*`)
   - the `APP_NAME` SWA app setting (used to build the upstream
     `pam/<APP_NAME>/...` URL)

   E.g. for `blotter`: rename `__APP__` to `blotter` and set
   `APP_NAME=blotter` in app settings.
3. **Replace the route placeholder.** Quick sed:
   ```bash
   cd <your-app>/api
   mv __APP__ <slug>
   sed -i "s/__APP__/<slug>/g" <slug>/function.json
   ```
4. **Wire the workflow** by setting `api_location: "api"` in the
   consumer workflow YAML:
   ```yaml
   uses: 1823-partners/infrastructure/.github/workflows/swa-deploy.yml@main
   with:
     azure_token_secret_name: AZURE_STATIC_WEB_APPS_API_TOKEN_…
     api_location: "api"
   secrets: inherit
   ```
5. **Set the SWA app settings** (Azure Portal → Configuration →
   Application settings) on **both** Production and Preview environments
   (Preview does NOT inherit from Production):

   | Setting                    | Value                              |
   |----------------------------|------------------------------------|
   | `APP_NAME`                 | the URL slug, e.g. `blotter`       |
   | `BEACON_APP_TOKEN_ID`      | per-app token id                   |
   | `BEACON_APP_TOKEN_SECRET`  | per-app token secret               |
   | `BEACON_URL`               | `https://pam.wsq.io`               |
   | `BEACON_USER_TOKEN_ID`     | service user token id              |
   | `BEACON_USER_TOKEN_SECRET` | service user token secret          |
   | `DB_ENV`                   | `prod` (or `prod_snap`, `dev`)     |
   | `NODE_AUTH_TOKEN`          | GitHub Packages PAT (`read:packages`) — needed for Oryx to install `@1823-partners/swa-proxy` at deploy time |

6. **Update the frontend API client** to point at `/api/<slug>` and
   remove the bundled token JSONs:
   - Delete `src/api/beacon_user_token.json`.
   - Delete `src/api/beacon_app_token_<APP>.json`.
   - In `src/api/index.js`, change the base URL from
     `${BEACON_URL}/r/${DB_ENV}/pam/<slug>` to `/api/<slug>` and remove
     the `getAuthToken` handshake — the proxy handles auth.
   - 1823-core ≥1.14.0 ships `createBeaconProxyApi({ appName })` for
     this exact pattern; preferred over hand-rolling the client.
7. **Deploy and verify:**
   - Push to `main` → preview environment, then to a release branch
     for production.
   - Hit `/api/<slug>/<known-endpoint>` from the deployed app and
     confirm a 200 with the expected body.
   - Inspect the deployed bundle to confirm no `beacon_*_token*.json`
     strings remain.

## Files in this template

| File                     | Purpose                                                      |
|--------------------------|--------------------------------------------------------------|
| `host.json`              | Functions runtime config (extension bundle v4)               |
| `package.json`           | Single dep: `@1823-partners/swa-proxy`                       |
| `.npmrc`                 | GH Packages registry + `${NODE_AUTH_TOKEN}` substitution     |
| `__APP__/function.json`  | HTTP trigger, routes `<app>/{*path}`                         |
| `__APP__/index.js`       | 4-line wrapper around `createBeaconProxy()`                  |

## Reference: working examples

- `bob-dashboard/api/bob-dashboard/`
- `permissions/api/permissions/`

Both consumers are identical 4-line wrappers; all proxy behavior lives in
`@1823-partners/swa-proxy`.
