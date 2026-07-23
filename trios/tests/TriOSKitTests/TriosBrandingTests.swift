import XCTest
@testable import TriOSKit

final class TriosBrandingTests: XCTestCase {
    func testCentralDisplayName() {
        XCTAssertEqual(TriosBranding.displayName, "Trinity S\u{00B3}AI")
    }

    func testUnbrandedComposerPlaceholder() {
        XCTAssertEqual(TriosBranding.messagePlaceholder, "Message...")
    }

    func testLocalTypingIndicatorHasNoDuplicateBrand() {
        XCTAssertNil(TriosBranding.localTypingLabel)
    }

    func testStatusBarHasNoDuplicateBrand() {
        XCTAssertNil(TriosBranding.statusProductLabel)
    }

    func testSenderLabels() {
        XCTAssertEqual(ChatSenderLabelPolicy.label(for: .user), "You")
        XCTAssertNil(ChatSenderLabelPolicy.label(for: .assistant))
        XCTAssertNil(ChatSenderLabelPolicy.label(for: .system))
    }
}
