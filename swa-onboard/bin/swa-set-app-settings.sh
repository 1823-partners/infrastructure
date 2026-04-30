#!/usr/bin/env bash
# swa-set-app-settings.sh
#
# Bulk-set SWA Application Settings across every onboarded 1823 SWA, for
# both Production and named Preview environments.
#
# Why: Preview environments do NOT inherit app settings from Production
# (Azure SWA limitation). Manually clicking through the Portal for every
# (app x environment) pair is error-prone and tedious. This script reads
# a small config + a sourced secrets file, then iterates `az staticwebapp
# appsettings set` for each (app, environment).
#
# Usage:
#   swa-set-app-settings.sh \
#       --config <apps.json> \
#       [--secrets <secrets.env>] \
#       [--apps slug1,slug2] \
#       [--environments default,preview] \
#       [--dry-run]
#
# Inputs:
#   --config FILE
#       JSON config describing the onboarded SWAs. Schema:
#         {
#           "resource_group": "<az resource group>",
#           "global": {
#             "BEACON_URL": "https://pam.wsq.io",
#             "DB_ENV": "prod"
#           },
#           "apps": [
#             {
#               "slug": "permissions",
#               "swa_name": "<az static web app resource name>",
#               "app_name": "permissions"
#             },
#             ...
#           ]
#         }
#       `slug` is the URL slug; `app_name` is the Beacon server slug
#       (underscored). `swa_name` is the Azure resource name (NOT the
#       hostname) and is what `az staticwebapp` commands expect.
#
#   --secrets FILE
#       Bash file to `source` before running. Defines:
#         AAD_CLIENT_ID, AAD_CLIENT_SECRET           (shared across apps)
#         BEACON_USER_TOKEN_ID, BEACON_USER_TOKEN_SECRET  (shared)
#         NODE_AUTH_TOKEN                            (shared, GH PAT)
#         BEACON_APP_TOKEN_<UPPER_SLUG>_ID
#         BEACON_APP_TOKEN_<UPPER_SLUG>_SECRET       (per-app)
#       Where <UPPER_SLUG> is the slug uppercased with hyphens replaced
#       by underscores, e.g. `bob-dashboard` -> `BOB_DASHBOARD`.
#       If --secrets is omitted, the script expects all of the above to
#       be exported in the calling shell already.
#
#   --apps slug1,slug2
#       Restrict the run to these slugs (default: every app in --config).
#
#   --environments default,preview
#       SWA environments to update. `default` is Production. Other names
#       are Preview environments (e.g. `preview`). Default: `default`.
#       Repeat the script for each named preview env you keep around.
#
#   --dry-run
#       Print the `az` commands that would be run; do not execute.
#
# Requirements:
#   - `az` (logged in: `az login`, correct subscription selected)
#   - `jq`
#   - `bash` >= 4

set -euo pipefail

CONFIG=""
SECRETS=""
APPS_FILTER=""
ENVIRONMENTS="default"
DRY_RUN=0

usage() {
    sed -n '2,/^set -euo pipefail$/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --config)        CONFIG="$2";        shift 2 ;;
        --secrets)       SECRETS="$2";       shift 2 ;;
        --apps)          APPS_FILTER="$2";   shift 2 ;;
        --environments)  ENVIRONMENTS="$2";  shift 2 ;;
        --dry-run)       DRY_RUN=1;          shift   ;;
        -h|--help)       usage; exit 0       ;;
        *)               echo "Unknown arg: $1" >&2; usage; exit 1 ;;
    esac
done

if [[ -z "$CONFIG" ]]; then
    echo "ERROR: --config is required" >&2
    usage; exit 1
fi
if [[ ! -f "$CONFIG" ]]; then
    echo "ERROR: config file not found: $CONFIG" >&2
    exit 1
fi
if [[ "$DRY_RUN" -eq 0 ]] && ! command -v az >/dev/null 2>&1; then
    echo "ERROR: az CLI is not installed or not on PATH (use --dry-run to skip this check)" >&2
    exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is not installed or not on PATH" >&2
    exit 1
fi

if [[ -n "$SECRETS" ]]; then
    if [[ ! -f "$SECRETS" ]]; then
        echo "ERROR: secrets file not found: $SECRETS" >&2
        exit 1
    fi
    # shellcheck disable=SC1090
    source "$SECRETS"
fi

# Validate shared secrets early so we fail before touching any SWA.
require_var() {
    local name="$1"
    if [[ -z "${!name:-}" ]]; then
        echo "ERROR: required env var $name is not set (define it in --secrets or your shell)" >&2
        exit 1
    fi
}
require_var AAD_CLIENT_ID
require_var AAD_CLIENT_SECRET
require_var BEACON_USER_TOKEN_ID
require_var BEACON_USER_TOKEN_SECRET
require_var NODE_AUTH_TOKEN

RESOURCE_GROUP=$(jq -r '.resource_group // empty' "$CONFIG")
if [[ -z "$RESOURCE_GROUP" ]]; then
    echo "ERROR: config $CONFIG has no top-level .resource_group" >&2
    exit 1
fi

BEACON_URL=$(jq -r '.global.BEACON_URL // "https://pam.wsq.io"' "$CONFIG")
DB_ENV=$(jq -r '.global.DB_ENV // "prod"' "$CONFIG")

# Slug -> UPPER_SNAKE for per-app secret env-var names.
slug_to_upper_snake() {
    echo "$1" | tr '[:lower:]-' '[:upper:]_'
}

# Build the IFS-split filter set.
declare -A FILTER_SET=()
if [[ -n "$APPS_FILTER" ]]; then
    IFS=',' read -ra FILTER_ARR <<< "$APPS_FILTER"
    for f in "${FILTER_ARR[@]}"; do FILTER_SET["$f"]=1; done
fi

IFS=',' read -ra ENV_ARR <<< "$ENVIRONMENTS"

APP_COUNT=$(jq '.apps | length' "$CONFIG")
if [[ "$APP_COUNT" -eq 0 ]]; then
    echo "ERROR: config $CONFIG has no apps." >&2
    exit 1
fi

run_az() {
    if [[ "$DRY_RUN" -eq 1 ]]; then
        printf '  [dry-run] az %s\n' "$*"
    else
        # shellcheck disable=SC2068
        az $@ >/dev/null
    fi
}

for ((i = 0; i < APP_COUNT; i++)); do
    SLUG=$(jq -r ".apps[$i].slug" "$CONFIG")
    SWA_NAME=$(jq -r ".apps[$i].swa_name" "$CONFIG")
    APP_NAME=$(jq -r ".apps[$i].app_name // .apps[$i].slug" "$CONFIG" \
               | tr '-' '_')

    if [[ -n "$APPS_FILTER" && -z "${FILTER_SET[$SLUG]:-}" ]]; then
        continue
    fi

    UPPER=$(slug_to_upper_snake "$SLUG")
    APP_TOKEN_ID_VAR="BEACON_APP_TOKEN_${UPPER}_ID"
    APP_TOKEN_SECRET_VAR="BEACON_APP_TOKEN_${UPPER}_SECRET"
    require_var "$APP_TOKEN_ID_VAR"
    require_var "$APP_TOKEN_SECRET_VAR"
    APP_TOKEN_ID="${!APP_TOKEN_ID_VAR}"
    APP_TOKEN_SECRET="${!APP_TOKEN_SECRET_VAR}"

    for ENV_NAME in "${ENV_ARR[@]}"; do
        ENV_LABEL="$ENV_NAME"
        [[ "$ENV_NAME" == "default" ]] && ENV_LABEL="Production"
        echo ">> ${SLUG}  (swa=${SWA_NAME}, env=${ENV_LABEL})"

        # `az staticwebapp appsettings set` accepts space-separated
        # KEY=VALUE pairs after --setting-names. We pass values via
        # variable expansion (no quoting required here because we use
        # the array form to az).
        ARGS=(
            staticwebapp appsettings set
            --name "$SWA_NAME"
            --resource-group "$RESOURCE_GROUP"
        )
        # `default` is the implicit production environment; only pass
        # --environment-name for named preview envs.
        if [[ "$ENV_NAME" != "default" ]]; then
            ARGS+=( --environment-name "$ENV_NAME" )
        fi
        ARGS+=(
            --setting-names
            "AAD_CLIENT_ID=${AAD_CLIENT_ID}"
            "AAD_CLIENT_SECRET=${AAD_CLIENT_SECRET}"
            "BEACON_URL=${BEACON_URL}"
            "DB_ENV=${DB_ENV}"
            "APP_NAME=${APP_NAME}"
            "BEACON_USER_TOKEN_ID=${BEACON_USER_TOKEN_ID}"
            "BEACON_USER_TOKEN_SECRET=${BEACON_USER_TOKEN_SECRET}"
            "BEACON_APP_TOKEN_ID=${APP_TOKEN_ID}"
            "BEACON_APP_TOKEN_SECRET=${APP_TOKEN_SECRET}"
            "NODE_AUTH_TOKEN=${NODE_AUTH_TOKEN}"
        )

        run_az "${ARGS[@]}"
    done
done

echo
if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Dry-run complete. Re-run without --dry-run to apply."
else
    echo "Done. App settings applied to ${APP_COUNT} app(s) x ${#ENV_ARR[@]} environment(s)."
fi
