// FIXTURE - deliberately broken. Not compiled, not linked, only grepped.
//
// KeychainSecrets.readData with the dev-variant guard deleted. The body is
// still legal Swift, so this compiles - and a release build reads secrets
// out of DevSecretStore's plaintext files instead of the Keychain.
//
// `make guard-shapes` must reject this file.

    static func readData(
        service: String,
        account: String,
        allowsInteraction: Bool = true
    ) throws -> Data {
        guard let data = DevSecretStore.read(service: service, account: account) else {
            throw KeychainSecretsError.itemNotFound(service: service, account: account)
        }
        return data
    }
