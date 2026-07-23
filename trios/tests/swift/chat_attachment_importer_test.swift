import Foundation

@main
struct ChatAttachmentImporterTest {
    static func main() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("trios-importer-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: root) }

        let textURL = root.appendingPathComponent("notes.txt")
        try Data("hello".utf8).write(to: textURL)
        let imageURL = root.appendingPathComponent("screen.png")
        try Data([0x89, 0x50, 0x4e, 0x47]).write(to: imageURL)

        let importer = ChatAttachmentImporter(fileManager: fileManager)
        let text = try importer.attachment(from: textURL)
        let image = try importer.attachment(from: imageURL)

        expect(text.kind == .file, "text imports as file")
        expect(text.displayName == "notes.txt", "file name is retained")
        expect(text.byteCount == 5, "file size is retained")
        expect(text.url.path == textURL.standardizedFileURL.path, "stable file path is retained")
        expect(image.kind == .image, "PNG imports as image")
        expect(image.mediaType == "image/png", "PNG media type")

        do {
            _ = try importer.attachment(from: root)
            fail("directory must be rejected")
        } catch let error as ChatAttachmentImportError {
            if case .directory = error {
                // Expected.
            } else {
                fail("directory returns a specific error")
            }
        }

        print("All ChatAttachmentImporter tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() { fail(label) }
    }

    private static func fail(_ label: String) -> Never {
        FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
        exit(1)
    }
}
