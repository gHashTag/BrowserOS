// FIXTURE - deliberately broken. Not compiled, not linked, only grepped.
//
// TriOSEncryption.loadOrCreateSymmetricKey with the headless-run bypass
// guard deleted. Every build - including the release - would then derive
// its data key from a volatile file instead of the Keychain.
//
// `make guard-shapes` must reject this file.

    private func loadOrCreateSymmetricKey() throws -> SymmetricKey {
        // E2E/test bypass: avoid keychain permission dialogs in non-signed test
        // binaries by using a volatile file-based key instead.
        return try loadOrCreateTestKey()
    }
