// Minimal stand-ins for the app types TriosLogBus touches, so the bus can be
// compiled and exercised on its own without dragging in the SwiftUI target.
//
// Only `ProjectPaths.trinity` is referenced by the bus (for its default path);
// every test constructs a bus with an explicit temporary path instead.

import Foundation

enum ProjectPaths {
    static var root: String { NSTemporaryDirectory() + "trios-log-bus-stub" }
    static var trinity: String { "\(root)/.trinity" }
    static var trinityEventLog: String { "\(trinity)/event_log.jsonl" }
    static var trinityLog: String { "\(trinity)/cron.log" }
}
