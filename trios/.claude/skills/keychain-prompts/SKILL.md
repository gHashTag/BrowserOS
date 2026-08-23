---
name: keychain-prompts
description: Stop macOS asking for the login-keychain password on every run. Use whenever a keychain dialog appears repeatedly, before adding any locally-built tool that reads a secret, when "Always Allow" does not stick, or when someone proposes Touch ID as the fix. Carries the signing rule, the variant rule, and why biometry is the wrong instrument here.
---

# Why the keychain keeps asking, and how to make it stop

## The one rule

**A macOS keychain ACL is bound to the APPLICATION, identified by its code
signature.** A binary with no stable signature is a new, unknown application
every time it is built. So the login keychain asks again, and **"Always Allow"
cannot help** — it whitelists the exact binary in front of it, and the next
build is a different one.

Everything below follows from that sentence.

## The three cases in this repo

| What | Signature | Secrets | Prompts? |
|---|---|---|---|
| `trios.app` (prod) | `TriOS Development`, stable | Keychain | No — stable identity, allow once |
| `trios-dev.app` | ad-hoc (`-`), changes every build | **Files** (`DevSecretStore`) | No — never opens the keychain |
| a locally-built tool | ad-hoc unless you sign it | whatever it asks for | **Yes, forever** |

The third row is the gap, and it is where every recurring dialog has come
from. `build.sh` states the first two deliberately: dev is ad-hoc *because* it
never touches the keychain (`ProjectPaths.usesFileSecretStore`), and prod is
stably signed *because* it does.

## Measured instance, 2026-08-23

`make keychain-floor` built its probe to `mktemp -t trios_keychain_floor` and
let `swiftc` ad-hoc sign it. The operator got this on every single run:

> `trios_keychain_floor.CAEeoWVOrs wants to use your confidential information
> stored in "com.browseros.trios.encryption-key" in your keychain.`

Random path, ad-hoc signature, deleted seconds later. A brand-new application
each time; "Always Allow" whitelisted a file that no longer existed. Fixed at
`2d78a95a7` by building to `.trinity/build/keychain_floor` and signing with
the same identity the app uses.

An earlier instance: the release app was ad-hoc signed, so every rebuild
invalidated its own ACLs and produced several dialogs in a row. That is what
`scripts/create_dev_signing_identity.sh` was written for, and its header says
so.

## If a dialog is appearing right now

1. Read the app name in the dialog. It names the offending binary.
2. Confirm the identity exists:
   ```bash
   security find-identity -p codesigning | grep "TriOS Development"
   ```
   Nothing? Create it once — it needs no login password and weakens nothing:
   ```bash
   bash scripts/create_dev_signing_identity.sh
   ```
   It lives in its own `trios-signing.keychain-db` with a throwaway password,
   precisely so importing it does not ask for the thing it exists to prevent.
3. Make the offender stable and signed. Never `mktemp`:
   ```make
   bin="$(ROOT)/.trinity/build/<tool>"
   swiftc -O "$(ROOT)/tools/<tool>.swift" -o "$$bin"
   sign="$${TRIOS_SIGN_IDENTITY:-TriOS Development}"
   eval "$$(grep -E '^(KEYCHAIN_NAME|KEYCHAIN_PASSWORD)=' \
            "$(ROOT)/scripts/create_dev_signing_identity.sh")"
   security unlock-keychain -p "$$KEYCHAIN_PASSWORD" "$$KEYCHAIN_NAME"
   codesign --force --sign "$$sign" "$$bin"
   ```
   Read the keychain name and password out of the create script rather than
   repeating them, so the two cannot drift.
4. Run it once and answer **Always Allow**. That is the last time.

`.trinity/build/` is gitignored, so a stable path costs nothing.

## Do not reach for Touch ID

It is the wrong instrument here and it makes things worse:

- The key is stored with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
  and **no** `SecAccessControl`. Adding biometry means macOS demands a
  fingerprint on **every read, by design** — more interruptions, not fewer.
- It hard-fails every headless run. The Queen's cron rounds have nobody to
  press a finger, so the secret becomes unreadable exactly when it is needed.
- The dialog is not a keychain *unlock*. It is ACL authorization for an
  unrecognised binary. A fingerprint does not answer that question; a stable
  signature does.

Touch ID for unlocking the login keychain at login is a separate, fine thing
and is not what these dialogs are.

## Before adding any tool that reads a secret

Ask which of the three rows it is in. If it needs a real secret, it must be
signed. If it does not, run it against the file store instead and skip the
keychain entirely:

```bash
TRIOS_VARIANT=dev make <target>       # secrets from ~/.trios-dev/secrets/
TRIOS_E2E_DISABLE_KEYCHAIN=1 ...      # what the e2e harness uses
```

The cheapest keychain prompt is the one that never had to happen.

## Related

- `.claude/skills/agent-safe-build/SKILL.md` — building without disturbing a
  running app.
- A stalled read is a different failure. `KeychainPromptDetector` tells "the
  keychain is slow" from "the keychain is waiting for a human" by looking for
  `SecurityAgent`; a dialog nobody can see reads as an eight-second timeout.
