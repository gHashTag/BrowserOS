import Foundation
#if canImport(TriOSKit)
import TriOSKit
#endif
import XCTest

final class ChatAttachmentEncryptionTests: XCTestCase {
    private let fileManager = FileManager.default

    private var attachmentsBase: URL {
        fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first!
            .appendingPathComponent("Trinity S3AI", isDirectory: true)
            .appendingPathComponent("Attachments", isDirectory: true)
    }

    override func setUp() {
        super.setUp()
        try? fileManager.removeItem(at: attachmentsBase)
    }

    override func tearDown() {
        super.tearDown()
        try? fileManager.removeItem(at: attachmentsBase)
    }

    func testEncryptedAttachmentRoundTrip() throws {
        let importer = ChatAttachmentImporter()
        let sample = Data("fake-image-data".utf8)

        let attachment = try importer.persistImageData(sample, typeIdentifier: "public.png")
        XCTAssertTrue(attachment.isEncrypted)

        let ciphertext = try Data(contentsOf: attachment.url)
        XCTAssertNotEqual(ciphertext, sample)

        let decrypted = try attachment.loadDecryptedData()
        XCTAssertEqual(decrypted, sample)
    }

    func testPlaintextLegacyAttachmentPassesThrough() throws {
        let base = attachmentsBase
        try fileManager.createDirectory(at: base, withIntermediateDirectories: true)
        let fileURL = base.appendingPathComponent("legacy.png")
        let sample = Data("legacy-plaintext".utf8)
        try sample.write(to: fileURL)

        let attachment = ChatComposerAttachment(
            url: fileURL,
            displayName: "legacy.png",
            kind: .image,
            byteCount: Int64(sample.count),
            mediaType: "image/png",
            isEncrypted: false
        )

        let data = try attachment.loadDecryptedData()
        XCTAssertEqual(data, sample)
    }
}
