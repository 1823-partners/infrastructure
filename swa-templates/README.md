# SWA static config template

Canonical `staticwebapp.config.json` for 1823 SWAs. Copy into your app's
repo root and replace `__APP__` with the app's URL slug.

## Why

Default Azure SWA AAD uses a Microsoft-managed multi-tenant app and masks
`userDetails` (e.g. `Jac*****`) for guest (B2B) and personal MSA accounts.
That mask cascades into our identity-derived `MODIFIED_BY` and silently
403s the admin lookup. Pointing SWA at our own registered AAD app via
`auth.identityProviders.azureActiveDirectory.registration` makes Microsoft
treat it as a consented relying party so the full UPN flows through.

Once a SWA is on this config, the backend can trust the
`x-ms-client-principal` header for every account type — see
`pam-master/pam/servers/utils/auth.py::caller_email`.

## Adoption checklist

1. Copy `staticwebapp.config.json` into your app's repo root (replacing
   any existing one). Keep your app's existing routes if they differ;
   only the `auth` block and `responseOverrides` are mandatory.
2. Replace `__APP__` in the routes block with your app's URL slug.
   - If your app does **not** use the Function proxy (`api_location`
     unset in your workflow), delete the `/api/__APP__/*` route entirely.
3. Add the SWA hostname's redirect URI to the shared AAD app
   registration `pam-swa-shared` (Azure Portal → App registrations →
   pam-swa-shared → Authentication → Web → Add URI):

       https://<swa-hostname>/.auth/login/aad/callback

   Apply for **both** the production hostname and any preview /
   per-environment hostnames the SWA serves.
4. Set the following SWA app settings (Azure Portal → Configuration →
   Application settings) on **Production** and again on **Preview**
   (preview does NOT inherit production settings):

   | Setting             | Value                                        |
   |---------------------|----------------------------------------------|
   | `AAD_CLIENT_ID`     | shared `pam-swa-shared` client id            |
   | `AAD_CLIENT_SECRET` | shared `pam-swa-shared` client secret        |

   `AAD_TENANT_ID` is hardcoded in `openIdIssuer` (SWA does not
   interpolate setting names in that field) and does not need a
   per-app setting.
5. Push to `main` (or your release branch). Visit `/.auth/me` after
   deploy and confirm `clientPrincipal.userDetails` is the real UPN —
   not `Jac*****` — for both an employee and a guest test account.

## Reference: working example

The `permissions` SWA was the first adopter:
- `permissions/staticwebapp.config.json` — same shape as this template,
  with `__APP__` already replaced by `permissions`.
- `permissions/api/permissions/index.js` — proxy that consumes the
  verified principal header. See `infrastructure/swa-api-template/`.
