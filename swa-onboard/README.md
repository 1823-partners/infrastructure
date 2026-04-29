# swa-onboard

Scaffolding CLI that takes a 1823 SWA from "default Azure config + bundled
Beacon tokens" to "shared AAD app reg + Function proxy + server-side tokens"
in one command.

This tool lives in `infrastructure/` and is **not** published to GH Packages.
Run it directly with `node`. The scaffolded output is what gets committed —
the tool itself is never a runtime or build dependency of any consumer app.

## Install

```bash
cd infrastructure/swa-onboard
npm install
```

The only dep is `js-yaml` (for safe consumer-workflow edits).

## Usage

```bash
# From inside the target app's repo:
node ../infrastructure/swa-onboard/bin/swa-onboard.js init <app-slug>

# Or via --app-dir from anywhere:
node infrastructure/swa-onboard/bin/swa-onboard.js init blotter --app-dir ./blotter
```

### `init <app-slug>`

Scaffolds onto an existing SWA repo (must already have `package.json` and
`.github/workflows/azure-static-web-apps-*.yml`):

| Output                                              | What it does                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<app>/public/staticwebapp.config.json`             | Custom AAD provider (shared 1823 app reg), `/api/<slug>/*` route gate, 401→login redirect, explicit static excludes (no brace expansion).               |
| `<app>/api/host.json` + `.npmrc` + `package.json`   | Functions sub-app pointing at `@1823-partners/swa-proxy`. Has its own `package-lock.json` once `npm install` runs in the app.                          |
| `<app>/api/<slug>/function.json` + `index.js`       | HTTP-trigger Function that wraps `createBeaconProxy()` from `@1823-partners/swa-proxy`. Forwards `/api/<slug>/{*path}` to Beacon with the SWA-signed `x-ms-client-principal`. |
| `<app>/.github/workflows/azure-static-web-apps-*.yml` | Patched (via js-yaml) so the swa-deploy.yml call sets `api_location: "api"`. Idempotent.                                                              |
| `<app>/.app-settings.env.example`                   | Lists every SWA app setting the proxy + AAD config require, with sane defaults. Operator copies values into Azure Portal on **both** Production and Preview. |
| `<app>/.env.local.example`                          | Lists the `REACT_APP_*` vars a dev needs in `.env.local` for direct-mode `npm start` / `jest` (Beacon credentials + `REACT_APP_DEV_USER` for the X-Dev-Caller-Email interceptor). Gitignored target. |

What it deliberately does **not** do:

- **Modify `<app>/src/api/index.js`.** We don't know each app's API surface. The CLI prints the exact migration snippet (`createAppTransport`) for you to paste.
- **Bump `@1823-partners/core`.** Bumping a frontend dep is one `npm install` away — keeping it in your hands lets you see the lock-file delta in the same commit as the migration.
- **Create the AAD app reg or set redirect URIs.** That's a one-time Azure Portal action — see the SWA auth runbook.
- **Set Azure app settings.** Same reason — Portal-only, and Preview vs. Production are independent.

### `verify <hostname>`

Post-deploy smoke check. Run from the app dir, or pass `--app-dir`:

```bash
swa-onboard verify https://blotter.1823.partners
```

Exits non-zero if any check fails. Checks:

1. **`/.auth/me` returns an unmasked email.** Catches the default-AAD-provider regression (guests get `*****@…`).
2. **`/api/<slug>/` is gated.** Either 302→login or 401 — both indicate the route gate exists.
3. **`build/` is free of `beacon_user_token` / `beacon_app_token` strings.** The frontend migration to `createAppTransport` is complete.
4. **Slug consistency warning.** If the URL slug contains a hyphen, prints a reminder to set `APP_NAME=<slug-with-underscores>` (Beacon route is `pam/<APP_NAME>/...` and `APP_NAME` matches the `*_server.py` filename).

The first check curls without cookies, so it'll show "unauthenticated" by default — open `/.auth/me` in a browser to verify the unmasked-email piece end-to-end. Future iteration could add a headless browser flow.

## Tests

```bash
cd infrastructure/swa-onboard
npm test
```

Covers the helpers most likely to silently break (slug conversion, tree copy, idempotent workflow patch, env example contents). The CLI surface itself is thin enough that integration testing is by running it on a real app.

## Why this lives in `infrastructure/`

- The templates it consumes (`swa-templates/`, `swa-api-template/`) already live here. Co-locating means relative paths, no fetch, no version skew between "the template" and "the tool that knows how to apply the template."
- It's a one-shot scaffolder run by a small group of people, not a transitive dep. Publishing to GH Packages would add release-branch ceremony for no benefit.
- Operators already clone `infrastructure/` for the workflows + templates. No new auth surface.
