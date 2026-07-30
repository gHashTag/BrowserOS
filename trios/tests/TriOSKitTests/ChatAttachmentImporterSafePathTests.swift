import Foundation
// @testable, because the types under test are internal. A plain
// import compiles and sees none of them, which reads as "the type is
// missing" rather than "this import cannot see it".
#if canImport(TriOSKit)
@testable import TriOSKit
#endif
import XCTest

final class ChatAttachmentImporterSafePathTests: XCTestCase {
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

    func testSafeFilePathAllowsNormalAttachmentFilename() {
        let base = URL(fileURLWithPath: "/tmp/test-attachments")
        let destination = base.appendingPathComponent("image.png")

        XCTAssertNoThrow(
            try SafeFilePath.validateWritePath(candidate: destination, baseURL: base)
        )
    }

    func testSafeFilePathRejectsPathOutsideBaseDirectory() {
        let base = URL(fileURLWithPath: "/tmp/test-attachments")
        let destination = URL(fileURLWithPath: "/tmp/../etc/passwd")

        XCTAssertThrowsError(
            try SafeFilePath.validateWritePath(candidate: destination, baseURL: base)
        ) { error in
            guard let safeError = error as? SafeFilePathError else {
                XCTFail("Expected SafeFilePathError, got \(type(of: error))")
                return
            }
            // Matched by case, not equality: the case carries the offending
            // path, which this test does not and should not know - asserting it
            // would pin a temporary directory name into the expectation.
            guard case .pathOutsideBase = safeError else {
                XCTFail("Expected pathOutsideBase, got \(safeError)")
                return
            }
        }
    }

    func testSafeFilePathRejectsSensitivePathComponents() {
        let base = URL(fileURLWithPath: "/tmp/test-attachments")
        let destination = base.appendingPathComponent("../.ssh/id_rsa")

        XCTAssertThrowsError(
            try SafeFilePath.validateWritePath(candidate: destination, baseURL: base)
        ) { error in
            guard let safeError = error as? SafeFilePathError else {
                XCTFail("Expected SafeFilePathError, got \(type(of: error))")
                return
            }
            guard case .sensitivePath(let path) = safeError else {
                XCTFail("Expected sensitivePath, got \(safeError)")
                return
            }
            // The component is still what matters; the case just reports the
            // whole path now.
            XCTAssertTrue(path.contains(".ssh"), "the rejected path names the sensitive component")
        }
    }

    func testSafeFilePathRejectsSymlinkEscape() throws {
        let tempDir = fileManager.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fileManager.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: tempDir) }

        let realDir = tempDir.appendingPathComponent("real", isDirectory: true)
        let linkDir = tempDir.appendingPathComponent("link", isDirectory: true)
        try fileManager.createDirectory(at: realDir, withIntermediateDirectories: true)
        try fileManager.createSymbolicLink(at: linkDir, withDestinationURL: realDir)

        let base = linkDir
        let destination = tempDir.appendingPathComponent("escaped.png")

        XCTAssertThrowsError(
            try SafeFilePath.validateWritePath(candidate: destination, baseURL: base)
        ) { error in
            guard let safeError = error as? SafeFilePathError else {
                XCTFail("Expected SafeFilePathError, got \(type(of: error))")
                return
            }
            // Matched by case, not equality: the case carries the offending
            // path, which this test does not and should not know - asserting it
            // would pin a temporary directory name into the expectation.
            guard case .pathOutsideBase = safeError else {
                XCTFail("Expected pathOutsideBase, got \(safeError)")
                return
            }
        }
    }

    func testPersistImageDataCreatesDirectoryWithRestrictedPermissionsAndExcludesFromBackup() throws {
        let importer = ChatAttachmentImporter()
        let sample = Data("fake-image".utf8)

        let attachment = try importer.persistImageData(sample, typeIdentifier: "public.png")

        let directory = attachmentsBase
        XCTAssertTrue(fileManager.fileExists(atPath: directory.path))

        let permissions = try directory.resourceValues(forKeys: [.fileResourceTypeKey, .nameKey])
        let attrs = try fileManager.attributesOfItem(atPath: directory.path)
        let posixMode = attrs[.posixPermissions] as? NSNumber
        XCTAssertEqual(posixMode?.int16Value, 0o700)

        let excluded = try directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertTrue(excluded.isExcludedFromBackup == true)

        let fileURL = attachment.url
        XCTAssertTrue(fileManager.fileExists(atPath: fileURL.path))
        XCTAssertEqual(attachment.mediaType, "image/png")
        XCTAssertTrue(attachment.isEncrypted, "persisted image attachments must be encrypted at rest")

        let ciphertext = try Data(contentsOf: fileURL)
        XCTAssertNotEqual(ciphertext, sample, "ciphertext must differ from plaintext")
        let plaintext = try attachment.loadDecryptedData()
        XCTAssertEqual(plaintext, sample, "decrypt must return original plaintext")
    }
}
