#!/usr/bin/env bash
# Stores the release-signing secrets this repository's release workflow needs, from the files the
# owner already keeps on this Mac. Run it once, on the owner's machine, signed in with `gh`.
#
#   scripts/release-secrets.sh <APPLE_API_ISSUER>
#
# It never prints a secret. It reads:
#   ~/.secrets/talkak-updater.key                    → TAURI_SIGNING_PRIVATE_KEY (+ empty password)
#   ~/.appstoreconnect/private_keys/AuthKey_<ID>.p8  → APPLE_API_KEY_CONTENT and APPLE_API_KEY (<ID>)
#   the "Developer ID Application" identity in the login keychain
#                                                    → APPLE_CERTIFICATE (.p12, base64),
#                                                      APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY
# macOS asks once for keychain access when the certificate is exported; that dialog is the OS's.
# The issuer ID is the only value not on disk: App Store Connect → Users and Access → Integrations.
set -euo pipefail

REPO="${TALKAK_RELEASE_REPO:-Daeseon-AI-Factory/talkak-developer}"
ISSUER="${1:-${APPLE_API_ISSUER:-}}"
UPDATER_KEY="${TAURI_UPDATER_KEY_PATH:-$HOME/.secrets/talkak-updater.key}"
API_KEY_DIR="${APPLE_API_KEY_DIR:-$HOME/.appstoreconnect/private_keys}"

fail() { echo "release-secrets: $*" >&2; exit 1; }

command -v gh >/dev/null || fail "gh is not installed"
gh auth status >/dev/null 2>&1 || fail "gh is not signed in"
[ -f "$UPDATER_KEY" ] || fail "updater key not found at $UPDATER_KEY"
api_key_file=$(ls "$API_KEY_DIR"/AuthKey_*.p8 2>/dev/null | head -n 1 || true)
[ -n "$api_key_file" ] || fail "no AuthKey_*.p8 under $API_KEY_DIR"
api_key_id=$(basename "$api_key_file" .p8); api_key_id="${api_key_id#AuthKey_}"
identity=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -n 1)
[ -n "$identity" ] || fail "no Developer ID Application identity in the keychain"
[ -n "$ISSUER" ] || fail "pass the App Store Connect issuer ID as the first argument"

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
p12_password=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)
# The export reads the private key: macOS shows its own access prompt here.
security export -t identities -f pkcs12 -k "$HOME/Library/Keychains/login.keychain-db" \
  -P "$p12_password" -o "$workdir/developer-id.p12" >/dev/null

gh secret set TAURI_SIGNING_PRIVATE_KEY -R "$REPO" < "$UPDATER_KEY"
printf '' | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R "$REPO"
base64 < "$workdir/developer-id.p12" | tr -d '\n' | gh secret set APPLE_CERTIFICATE -R "$REPO"
printf '%s' "$p12_password" | gh secret set APPLE_CERTIFICATE_PASSWORD -R "$REPO"
printf '%s' "$identity" | gh secret set APPLE_SIGNING_IDENTITY -R "$REPO"
printf '%s' "$api_key_id" | gh secret set APPLE_API_KEY -R "$REPO"
gh secret set APPLE_API_KEY_CONTENT -R "$REPO" < "$api_key_file"
printf '%s' "$ISSUER" | gh secret set APPLE_API_ISSUER -R "$REPO"

echo "release secrets stored in $REPO:"
gh secret list -R "$REPO" | awk '{print "  " $1}'
