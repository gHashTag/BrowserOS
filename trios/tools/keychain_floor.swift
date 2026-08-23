// Measure the floor cost of a cold Keychain data read on this machine.
//
// Why this exists.
//
// For weeks every launch produced `keychain.read.stalled` and nobody knew what
// the underlying operation actually costs. The caller's deadline is two
// seconds. Measured 2026-08-23 on this machine, first touch of three distinct
// items in one fresh process:
//
//     pass 1:  65.410s   4.435s   3.940s
//     pass 2:   0.070s   0.011s   0.012s
//
// The cost is per item, per process, on FIRST touch. A two-second deadline on
// an operation whose measured floor is four to sixty-five seconds is not a
// timeout - it guarantees a stall on every cold start, for every item, and the
// sixty-second cooldown then compounds it.
//
// Attribute reads are NOT this: `kSecReturnAttributes` answers from metadata in
// a fifth of a millisecond. Only `kSecReturnData` consults the ACL. Probing the
// wrong one is how this measurement was missed twice in one round.
//
// This tool NEVER prints secret material - only byte counts, statuses and
// timings.
//
// Run:  make keychain-floor

import Foundation
import Security

func coldRead(service: String, account: String) -> (OSStatus, Double, Int) {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
        // Exactly what KeychainSecrets sets: no dialog, ever.
        kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
    ]
    var out: CFTypeRef?
    let started = Date()
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    let seconds = Date().timeIntervalSince(started)
    // Size only. The bytes themselves never leave this function.
    let byteCount = (out as? Data)?.count ?? 0
    return (status, seconds, byteCount)
}

/// Every generic-password item this app owns, so the report covers what the app
/// actually reads rather than one item somebody remembered.
func ownedItems() -> [(String, String)] {
    var found: [(String, String)] = []
    for service in [
        "com.browseros.trios.model-keys",
        "com.browseros.trios.encryption-key",
        "ai.browseros.trios",
    ] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let items = out as? [[String: Any]]
        else { continue }
        for item in items {
            if let account = item[kSecAttrAccount as String] as? String {
                found.append((service, account))
            }
        }
    }
    return found
}

let items = ownedItems()
guard !items.isEmpty else {
    print("no generic-password items found for this app's services - nothing to measure")
    print("-- REPORT: an empty list is not a fast Keychain, it is an absent one.")
    exit(0)
}

print("cold-read floor, \(items.count) item(s), two passes in one process")
print("pass 1 is first touch; pass 2 is the same items again, same process.\n")

var firstTouch: [Double] = []
var warm: [Double] = []

for pass in 1...2 {
    print("pass \(pass):")
    for (service, account) in items {
        let (status, seconds, bytes) = coldRead(service: service, account: account)
        if pass == 1 { firstTouch.append(seconds) } else { warm.append(seconds) }
        let shortAccount = account.count > 30 ? String(account.prefix(30)) + "..." : account
        print(String(format: "  %8.3fs  status=%d bytes=%d  ", seconds, Int(status), bytes)
              + service + " / " + shortAccount)
    }
    print("")
}

func summary(_ label: String, _ times: [Double]) {
    guard !times.isEmpty else { return }
    let sorted = times.sorted()
    let padded = label.padding(toLength: 12, withPad: " ", startingAt: 0)
    print(padded + String(format: "min=%.3fs median=%.3fs max=%.3fs total=%.3fs",
                          sorted[0], sorted[sorted.count / 2],
                          sorted[sorted.count - 1], times.reduce(0, +)))
}
summary("first touch", firstTouch)
summary("warm", warm)

let deadline = 2.0
let overDeadline = firstTouch.filter { $0 > deadline }.count
print("")
print(String(format: "%d of %d first touches exceeded the %.0fs caller deadline.",
             overDeadline, firstTouch.count, deadline))
print("-- REPORT: timings only. A first touch over the deadline means the app's own")
print("   read of that item CANNOT succeed on a cold start; it is not a slow day.")
