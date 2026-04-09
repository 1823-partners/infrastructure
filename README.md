# infrastructure

Shared CI/CD workflows and infrastructure for 1823 Partners frontend applications.

## Reusable Workflows

### `swa-deploy.yml` — Azure Static Web Apps CI/CD

A reusable GitHub Actions workflow that provides a standardized build-and-deploy pipeline for all 1823 frontend React applications.

#### What it does

1. **Checkout** the repository
2. **Setup Node.js** (default: 22) with GitHub Packages authentication for `@1823-partners` scoped packages
3. **Install dependencies** via `npm ci`
4. **Run unit tests** (optional, enabled by default) with `npm test -- --watchAll=false --ci`
5. **Build** the production bundle with `npm run build`
6. **Deploy** to Azure Static Web Apps:
   - `main` branch pushes deploy to the **preview** environment
   - `release-*` branch pushes deploy to **production**
   - Pull requests deploy to **staging** (auto-cleaned on PR close)

#### Usage

In your app's `.github/workflows/azure-static-web-apps-*.yml`:

```yaml
name: Azure Static Web Apps CI/CD
on:
  push:
    branches: [main, release-*]
  pull_request:
    types: [opened, synchronize, reopened, closed]
    branches: [main, release-*]

jobs:
  deploy:
    uses: 1823-partners/infrastructure/.github/workflows/swa-deploy.yml@main
    with:
      azure_token_secret_name: AZURE_STATIC_WEB_APPS_API_TOKEN_YOUR_APP
    secrets: inherit
```

#### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `azure_token_secret_name` | Yes | -- | Name of the Azure SWA API token secret |
| `node_version` | No | `"22"` | Node.js version |
| `run_tests` | No | `true` | Whether to run unit tests before deploy |
| `test_args` | No | `""` | Extra arguments for `npm test` |

#### Permissions Required

```yaml
permissions:
  contents: read
  packages: read        # For @1823-partners npm packages
  pull-requests: write  # For PR deployment comments
```

## Adding a New App

1. Create the Azure Static Web App resource in Azure Portal
2. Copy the API token to a GitHub org secret
3. Add a workflow file referencing `swa-deploy.yml` with the token secret name
4. Push to `main` to trigger the first deployment
