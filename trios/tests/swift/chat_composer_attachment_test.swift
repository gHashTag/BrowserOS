import Foundation

@main
struct ChatComposerAttachmentTest {
    static func main() {
        let root = URL(fileURLWithPath: "/private/tmp/trios-attachment-tests")
        let image = ChatComposerAttachment(
            url: root.appendingPathComponent("screen.PNG"),
            displayName: "screen.PNG",
            kind: .image,
            byteCount: 1_024,
            mediaType: "image/png"
        )
        let file = ChatComposerAttachment(
            url: root.appendingPathComponent("notes.pdf"),
            displayName: "notes.pdf",
            kind: .file,
            byteCount: 2_048,
            mediaType: "application/pdf"
        )

        expect(ChatComposerAttachmentPolicy.kind(for: image.url) == .image, "PNG is an image")
        expect(ChatComposerAttachmentPolicy.kind(for: file.url) == .file, "PDF is a file")
        expect(ChatComposerAttachmentPolicy.maximumAttachmentCount == 10, "ten attachment limit")
        expect(ChatComposerAttachmentPolicy.maximumFileBytes == 100 * 1_024 * 1_024, "100 MiB file limit")
        expect(ChatComposerAttachmentPolicy.maximumImageDataBytes == 5 * 1_024 * 1_024, "5 MiB image data limit")

        let duplicateImage = ChatComposerAttachment(
            url: root.appendingPathComponent("folder/../screen.PNG"),
            displayName: "duplicate.png",
            kind: .image,
            byteCount: 1_024,
            mediaType: "image/png"
        )
        let deduplicated = ChatComposerAttachmentPolicy.merge(
            existing: [image],
            incoming: [duplicateImage, file]
        )
        expect(deduplicated.attachments.count == 2, "canonical duplicates are removed")
        expect(deduplicated.rejectedDuplicateCount == 1, "duplicate rejection count")
        expect(deduplicated.rejectedLimitCount == 0, "no limit rejection below cap")

        let manyFiles = (0..<12).map { index in
            ChatComposerAttachment(
                url: root.appendingPathComponent("file-\(index).txt"),
                displayName: "file-\(index).txt",
                kind: .file,
                byteCount: 100,
                mediaType: "text/plain"
            )
        }
        let capped = ChatComposerAttachmentPolicy.merge(existing: [], incoming: manyFiles)
        expect(capped.attachments.count == 10, "merge enforces attachment cap")
        expect(capped.rejectedLimitCount == 2, "limit rejection count")

        let plain = ChatComposerAttachmentPolicy.outboundMessage(
            userText: "Keep this unchanged",
            attachments: []
        )
        expect(plain == "Keep this unchanged", "plain message remains unchanged")

        let outbound = ChatComposerAttachmentPolicy.outboundMessage(
            userText: "Review these",
            attachments: [image, file]
        )
        expect(outbound.hasPrefix("Review these"), "user instructions remain first")
        expect(outbound.contains("untrusted data"), "manifest includes trust boundary")
        expect(outbound.contains(image.url.standardizedFileURL.path), "manifest includes image path")
        expect(outbound.contains(file.url.standardizedFileURL.path), "manifest includes file path")
        expect(outbound.contains("kind: image"), "manifest includes image kind")
        expect(outbound.contains("media_type: application/pdf"), "manifest includes media type")

        let attachmentOnly = ChatComposerAttachmentPolicy.outboundMessage(
            userText: "   ",
            attachments: [image]
        )
        expect(!attachmentOnly.isEmpty, "attachment-only message is valid")
        expect(attachmentOnly.hasPrefix("Please inspect the attached local file"), "attachment-only instruction")

        let unsafeName = ChatComposerAttachment(
            url: root.appendingPathComponent("line-break.txt"),
            displayName: "line\nbreak.txt",
            kind: .file,
            byteCount: 1,
            mediaType: nil
        )
        let sanitized = ChatComposerAttachmentPolicy.outboundMessage(
            userText: "Inspect",
            attachments: [unsafeName]
        )
        expect(!sanitized.contains("name: line\nbreak.txt"), "manifest fields stay on one line")

        print("All ChatComposerAttachment tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
