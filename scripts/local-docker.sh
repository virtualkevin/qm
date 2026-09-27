#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f "${CODEX_AUTH_FILE:-$HOME/.codex/auth.json}" ]]; then
  echo "A local Codex sign-in is required. Set CODEX_AUTH_FILE to an existing auth.json."
  exit 1
fi
if [[ ! -f "${MEMORABLE_CONFIG_FILE:-$HOME/.memorable/config.json}" ]]; then
  echo "An existing Memorable sign-in is required. Set MEMORABLE_CONFIG_FILE to its config.json."
  exit 1
fi
if [[ ! -f deploy/local/local.env ]]; then
  node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; const keys = ["CONNECTOR_SECRET_KEY", "CORE_SIGNING_SECRET", "PORTAL_IDENTITY_SECRET", "PORTAL_SESSION_SECRET"]; writeFileSync("deploy/local/local.env", keys.map(key => `${key}=${randomBytes(32).toString("hex")}\n`).join(""), { mode: 0o600, flag: "wx" });'
fi
docker build -f deploy/local/Sandbox.Dockerfile -t qm-local-sandbox:dev .
docker compose -f deploy/local/compose.yaml up --build -d
docker compose -f deploy/local/compose.yaml exec -T core memorable enable --scope personal:dev
