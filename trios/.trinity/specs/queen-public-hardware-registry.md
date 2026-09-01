# Queen Public Hardware Registry

Issue: gHashTag/trios#1313

## Boundary

Publish a public, read-only, signed view of operator-supplied FPGA evidence. This
service must not discover boards, program hardware, or duplicate the hardware
source of truth. It only signs a redacted projection of configured observations.

## Input

- `QUEEN_FPGA_REGISTRY_JSON`: a JSON array of operator-supplied observations.
- `QUEEN_FPGA_SIGNING_PRIVATE_KEY`: an Ed25519 private key in PKCS8 PEM form.
- `QUEEN_FPGA_SIGNING_KEY_ID`: a non-secret stable key identifier.

Each observation contains an opaque public `id`, board family, evidence URI,
readiness state, and optional last-observed timestamp. Private addresses,
hostnames, serial numbers, credentials, and arbitrary extra properties are never
copied to the public payload.

## Output

`GET /queen/public-hardware` returns a canonical payload, detached Ed25519
signature, SPKI public key, algorithm, and key identifier. The canonical payload
contains only allowlisted fields.

Allowed states are `registered`, `synthesised`, `programmed`, and `online`.
`online` requires `observedAt` no older than 120 seconds at response time. An
older observation is demoted to `programmed`. No timestamp means no online
claim.

## Failure behavior

Missing configuration, invalid JSON, invalid keys, duplicate IDs, unsupported
states, invalid evidence URIs, or invalid timestamps return HTTP 503 with no
last-known payload. No unsigned success response exists.

## Non-regression

Existing Queen status, board, activity, and research endpoints remain unchanged.
No board programming or hardware discovery is introduced.
