#!/bin/bash
# Creates a stable code-signing identity for TriOS development.
#
# WHY THIS EXISTS
# ---------------
# build.sh must re-sign the bundle after patching the SQLCipher install name:
# replacing any file inside a signed bundle invalidates the signature, and macOS
# then kills the app in dyld before main() runs.
#
# Signing ad-hoc (`codesign --sign -`) produces no stable identity. Every
# rebuild therefore looks like a *different application* to macOS, and keychain
# items are bound to the application that created them - so the login keychain
# asks for your password again after every build, once per stored service.
# Several dialogs in a row, forever.
#
# A stable certificate fixes that at the root: the identity stops changing, so
# clicking "Always Allow" once actually sticks. It weakens nothing - the secrets
# stay exactly as protected as before.
#
# WHY A SEPARATE KEYCHAIN
# -----------------------
# The obvious place for the certificate is the login keychain, but importing
# there and marking it trusted both need your login password - which is the very
# thing this script exists to stop you typing. So the certificate lives in its
# own keychain with a throwaway password instead. That keychain holds one
# self-signed development certificate and nothing else: there is no secret in it
# to protect, which is what makes a hardcoded password acceptable here and
# nowhere else.
#
# The certificate is untrusted, and that is fine. Trust governs whether *other*
# machines accept the signature; codesign signs and `--verify --deep --strict`
# passes regardless. Note the consequence: `security find-identity -v` ("valid
# identities only") lists nothing, so any check written that way will not see
# this identity. build.sh deliberately omits -v for that reason.
#
# Run it once:
#   bash scripts/create_dev_signing_identity.sh
#
# Afterwards plain ./build.sh picks the identity up on its own.
#
# To undo:  security delete-keychain trios-signing.keychain

set -e

IDENTITY_NAME="${1:-TriOS Development}"
KEYCHAIN_NAME="trios-signing.keychain"
KEYCHAIN_PATH="$HOME/Library/Keychains/$KEYCHAIN_NAME-db"
# Not a secret: this keychain contains one public development certificate.
KEYCHAIN_PASSWORD="trios-dev"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

if security find-identity -p codesigning 2>/dev/null | grep -q "$IDENTITY_NAME"; then
    echo "[OK] Signing identity already exists: $IDENTITY_NAME"
    exit 0
fi

echo "Creating self-signed code-signing certificate: $IDENTITY_NAME"

cat > "$WORK_DIR/openssl.cnf" <<'CONF'
[ req ]
distinguished_name = dn
x509_extensions    = ext
prompt             = no

[ dn ]
CN = PLACEHOLDER_CN

[ ext ]
basicConstraints     = critical,CA:false
keyUsage             = critical,digitalSignature
extendedKeyUsage     = critical,codeSigning
CONF
sed -i '' "s/PLACEHOLDER_CN/$IDENTITY_NAME/" "$WORK_DIR/openssl.cnf"

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$WORK_DIR/key.pem" -out "$WORK_DIR/cert.pem" \
    -config "$WORK_DIR/openssl.cnf" 2>/dev/null

# -legacy: OpenSSL 3 defaults to an encryption scheme the macOS importer
# rejects with "MAC verification failed", which reads like a wrong password and
# is not one. An empty export password fails the same way, hence a real one.
openssl pkcs12 -export -legacy \
    -inkey "$WORK_DIR/key.pem" -in "$WORK_DIR/cert.pem" \
    -out "$WORK_DIR/identity.p12" -passout "pass:$KEYCHAIN_PASSWORD" 2>/dev/null

if [ ! -f "$KEYCHAIN_PATH" ]; then
    security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
fi
# No auto-lock: a locked keychain makes codesign prompt, which is the failure
# mode this script exists to remove.
security set-keychain-settings "$KEYCHAIN_NAME"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"

# -T grants codesign access to the private key without a prompt per signature.
security import "$WORK_DIR/identity.p12" -k "$KEYCHAIN_NAME" -P "$KEYCHAIN_PASSWORD" \
    -T /usr/bin/codesign -T /usr/bin/security

security set-key-partition-list -S apple-tool:,apple:,codesign: \
    -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME" >/dev/null 2>&1 ||
    echo "[WARN] set-key-partition-list failed; codesign may prompt once."

# Append to the search list, never replace it. Dropping the login keychain here
# would cut every application off from its stored secrets.
if ! security list-keychains -d user | grep -q "$KEYCHAIN_NAME"; then
    EXISTING="$(security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"$//')"
    # shellcheck disable=SC2086
    security list-keychains -d user -s $(echo "$EXISTING" | tr '\n' ' ') "$KEYCHAIN_PATH"
fi

echo "[OK] Created signing identity: $IDENTITY_NAME"
security find-identity -p codesigning | grep "$IDENTITY_NAME" || true
echo
echo "Plain ./build.sh will now use it. On the next launch click \"Always Allow\""
echo "once per keychain dialog; because the identity is stable they stay away."
