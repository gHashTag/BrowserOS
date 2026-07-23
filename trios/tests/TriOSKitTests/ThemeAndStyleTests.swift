import XCTest
@testable import TriOSKit

final class ChatComposerStyleTests: XCTestCase {
    func testCompactAndExpandedInsets() {
        let compact = ChatComposerStyle.metrics(for: .compact)
        let expanded = ChatComposerStyle.metrics(for: .expanded)
        XCTAssertEqual(compact.horizontalInset, 10)
        XCTAssertEqual(expanded.horizontalInset, 16)
    }

    func testCornerRadiusContinuous() {
        let compact = ChatComposerStyle.metrics(for: .compact)
        let expanded = ChatComposerStyle.metrics(for: .expanded)
        XCTAssertEqual(compact.cornerRadius, 22)
        XCTAssertEqual(expanded.cornerRadius, 24)
    }

    func testBlackOverlayUsesCentralSurface() {
        let compact = ChatComposerStyle.metrics(for: .compact)
        let expanded = ChatComposerStyle.metrics(for: .expanded)
        XCTAssertEqual(
            compact.blackOverlayOpacity,
            TriosVisualTheme.current.composerBlackOpacity
        )
        XCTAssertEqual(
            expanded.blackOverlayOpacity,
            TriosVisualTheme.current.composerBlackOpacity
        )
        XCTAssertEqual(compact.blackOverlayOpacity, expanded.blackOverlayOpacity)
        XCTAssertLessThan(compact.blackOverlayOpacity, 1)
    }

    func testEditorHeightBounds() {
        let compact = ChatComposerStyle.metrics(for: .compact)
        let expanded = ChatComposerStyle.metrics(for: .expanded)
        XCTAssertEqual(compact.editorMinimumHeight, 42)
        XCTAssertEqual(compact.editorMaximumHeight, 110)
        XCTAssertEqual(expanded.editorMaximumHeight, 132)
    }

    func testPersistentShortcutStripRemoved() {
        let compact = ChatComposerStyle.metrics(for: .compact)
        let expanded = ChatComposerStyle.metrics(for: .expanded)
        XCTAssertFalse(compact.showsPersistentShortcutStrip)
        XCTAssertFalse(expanded.showsPersistentShortcutStrip)
    }

    func testInlineStatusEnabled() {
        let compact = ChatComposerStyle.metrics(for: .compact)
        let expanded = ChatComposerStyle.metrics(for: .expanded)
        XCTAssertTrue(compact.usesInlineStatus)
        XCTAssertTrue(expanded.usesInlineStatus)
    }
}

final class ChatGlassStyleTests: XCTestCase {
    func testCompactAndExpandedShareProfile() {
        let compact = ChatGlassStyle.profile(for: .compact)
        let expanded = ChatGlassStyle.profile(for: .expanded)
        XCTAssertEqual(compact, expanded)
    }

    func testContentRemainsTransparent() {
        let expanded = ChatGlassStyle.profile(for: .expanded)
        XCTAssertFalse(expanded.usesOpaqueContentFill)
    }

    func testSidebarAndContentPreserveGlass() {
        let expanded = ChatGlassStyle.profile(for: .expanded)
        XCTAssertLessThan(expanded.sidebarOverlayOpacity, 0.25)
        XCTAssertLessThan(expanded.contentOverlayOpacity, 0.25)
    }
}

final class TriosVisualThemeTests: XCTestCase {
    func testBlackLayersAreTransparent() {
        let theme = TriosVisualTheme.current
        let layers = [
            theme.rootBlackOpacity,
            theme.surfaceBlackOpacity,
            theme.elevatedBlackOpacity,
            theme.strongBlackOpacity,
            theme.nativeMaterialTintOpacity,
            theme.windowWashOpacity,
            theme.sidebarBlackOpacity,
            theme.contentBlackOpacity,
            theme.composerBlackOpacity
        ]
        XCTAssertTrue(layers.allSatisfy { $0 > 0 && $0 < 1 })
    }

    func testSurfaceHierarchy() {
        let theme = TriosVisualTheme.current
        XCTAssertGreaterThan(theme.strongBlackOpacity, theme.elevatedBlackOpacity)
        XCTAssertGreaterThan(theme.elevatedBlackOpacity, theme.surfaceBlackOpacity)
    }

    func testComposerMatchesContentGlass() {
        let theme = TriosVisualTheme.current
        XCTAssertEqual(theme.composerBlackOpacity, theme.contentBlackOpacity)
    }

    func testBorderAndDividerSubtle() {
        let theme = TriosVisualTheme.current
        XCTAssertLessThanOrEqual(theme.borderWhiteOpacity, 0.20)
        XCTAssertLessThanOrEqual(theme.dividerWhiteOpacity, theme.borderWhiteOpacity)
    }

    func testAmbientBloomSubtleAndBlurEnabled() {
        let theme = TriosVisualTheme.current
        XCTAssertLessThan(theme.ambientBloomOpacity, 0.10)
        XCTAssertTrue(theme.usesNativeBackdropBlur)
        XCTAssertFalse(theme.usesOpaqueContentFill)
    }
}

final class ChatScrollRestorationPolicyTests: XCTestCase {
    func testReturnsToChat() {
        XCTAssertTrue(
            ChatScrollRestorationPolicy.shouldRequestBottom(wasChatActive: false, isChatActive: true)
        )
    }

    func testChatStaysActive() {
        XCTAssertFalse(
            ChatScrollRestorationPolicy.shouldRequestBottom(wasChatActive: true, isChatActive: true)
        )
    }

    func testLeavingChat() {
        XCTAssertFalse(
            ChatScrollRestorationPolicy.shouldRequestBottom(wasChatActive: true, isChatActive: false)
        )
    }

    func testFinalAnchorTarget() {
        XCTAssertEqual(ChatScrollRestorationPolicy.target, .finalContentAnchor)
    }
}

final class TokenUsageTests: XCTestCase {
    func testProviderUsageAuthoritative() {
        var actual = TokenUsageLedger()
        actual.record(inputTokens: 900, outputTokens: 300, source: .provider)
        XCTAssertEqual(actual.inputTokens, 900)
        XCTAssertEqual(actual.outputTokens, 300)
        XCTAssertEqual(actual.totalTokens, 1_200)
        XCTAssertFalse(actual.includesEstimate)
        XCTAssertEqual(actual.compactTotal, "1.2K")
        XCTAssertEqual(actual.compactBreakdown, "900 in / 300 out")
    }

    func testEstimatedUsageMarked() {
        var estimated = TokenUsageLedger()
        estimated.record(inputTokens: 800, outputTokens: 250, source: .estimate)
        XCTAssertTrue(estimated.includesEstimate)
        XCTAssertEqual(estimated.compactTotal, "~1.1K")
        XCTAssertEqual(estimated.compactBreakdown, "~800 in / ~250 out")
        XCTAssertTrue(estimated.detailText.contains("input"))
        XCTAssertTrue(estimated.detailText.contains("output"))
    }

    func testTokenEstimatorFallback() {
        XCTAssertEqual(TokenEstimator.estimate("12345678"), 2)
    }
}
