import XCTest
@testable import TriOSKit

final class ChatLogicTests: XCTestCase {
    func testFirstPageIdParsing() {
        XCTAssertEqual(ChatLogic.firstPageId(in: "0. Example (tab 12)\n   https://example.com"), 0)
        XCTAssertEqual(ChatLogic.firstPageId(in: "3. Other (tab 5)\n   https://x"), 3)
        XCTAssertNil(ChatLogic.firstPageId(in: "No pages open."))
        XCTAssertNil(ChatLogic.firstPageId(in: ""))
        XCTAssertEqual(ChatLogic.firstPageId(in: "   2. Indented (tab 1)"), 2)
    }

    func testCommandRecognition() {
        XCTAssertTrue(ChatLogic.isLikelyCommand("shell ls -la"))
        XCTAssertTrue(ChatLogic.isLikelyCommand("open https://x"))
        XCTAssertTrue(ChatLogic.isLikelyCommand("screenshot"))
        XCTAssertTrue(ChatLogic.isLikelyCommand("/help"))
        XCTAssertTrue(ChatLogic.isLikelyCommand("./run.sh"))
        XCTAssertFalse(ChatLogic.isLikelyCommand("running late today"))
        XCTAssertFalse(ChatLogic.isLikelyCommand("what is the weather"))
        XCTAssertFalse(ChatLogic.isLikelyCommand("clicking through tabs"))
        // Known quirk: "swift " prefix is registered, so this sentence is treated as a command attempt.
        XCTAssertTrue(ChatLogic.isLikelyCommand("swift is a great language"))
    }

    func testExtractURL() {
        XCTAssertEqual(ChatLogic.extractURL(from: "open https://example.com/x now"), "https://example.com/x")
        XCTAssertNil(ChatLogic.extractURL(from: "no url here"))
    }

    func testParseIntent() {
        XCTAssertEqual(ChatLogic.parseIntent("screenshot", pageId: nil)?.0, "take_screenshot")
        XCTAssertEqual(ChatLogic.parseIntent("extract", pageId: nil)?.0, "get_page_content")
        XCTAssertEqual(ChatLogic.parseIntent("navigate https://x.com", pageId: nil)?.0, "navigate_page")
        XCTAssertNil(ChatLogic.parseIntent("what is the weather", pageId: nil))

        let ls = ChatLogic.parseIntent("ls -la", pageId: nil)
        XCTAssertEqual(ls?.0, "filesystem_bash")
        XCTAssertEqual(ls?.1["command"] as? String, "ls -la")

        let pwd = ChatLogic.parseIntent("pwd", pageId: nil)
        XCTAssertEqual(pwd?.0, "filesystem_bash")
    }
}
