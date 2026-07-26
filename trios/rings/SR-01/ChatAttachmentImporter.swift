import AppKit
import Foundation
import UniformTypeIdentifiers

enum ChatAttachmentImportError: LocalizedError {
    case unsupported
    case unreadable(String)
    case directory(String)
    case fileTooLarge(String)
    case imageTooLarge
    case persistenceFailed

    var errorDescription: String? {
        switch self {
        case .unsupported:
            return "This item is not a supported file or image."
        case .unreadable(let name):
            return "Cannot read \(name)."
        case .directory(let name):
            return "Folders are not supported yet: \(name)."
        case .fileTooLarge(let name):
            return "\(name) is larger than 100 MB."
        case .imageTooLarge:
            return "The dropped image is larger than 5 MB."
        case .persistenceFailed:
            return "The dropped image could not be saved."
        }
    }
}

struct ChatAttachmentImporter {
    private let fileManager: FileManager

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    func attachment(from url: URL) throws -> ChatComposerAttachment {
        let canonicalURL = url.standardizedFileURL.resolvingSymlinksInPath()
        let values = try canonicalURL.resourceValues(forKeys: [
            .isDirectoryKey,
            .isRegularFileKey,
            .fileSizeKey
        ])
        let name = canonicalURL.lastPathComponent.isEmpty ? "File" : canonicalURL.lastPathComponent

        if values.isDirectory == true {
            throw ChatAttachmentImportError.directory(name)
        }
        guard values.isRegularFile == true, fileManager.isReadableFile(atPath: canonicalURL.path) else {
            throw ChatAttachmentImportError.unreadable(name)
        }

        let byteCount = Int64(values.fileSize ?? 0)
        guard byteCount <= ChatComposerAttachmentPolicy.maximumFileBytes else {
            throw ChatAttachmentImportError.fileTooLarge(name)
        }
        let kind = ChatComposerAttachmentPolicy.kind(for: canonicalURL)
        let type = UTType(filenameExtension: canonicalURL.pathExtension)

        return ChatComposerAttachment(
            url: canonicalURL,
            displayName: name,
            kind: kind,
            byteCount: byteCount,
            mediaType: type?.preferredMIMEType
        )
    }

    func load(
        provider: NSItemProvider,
        completion: @escaping (Result<ChatComposerAttachment, Error>) -> Void
    ) {
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, error in
                if let error {
                    complete(.failure(error), completion: completion)
                    return
                }
                guard let url = fileURL(from: item) else {
                    complete(.failure(ChatAttachmentImportError.unsupported), completion: completion)
                    return
                }
                do {
                    complete(.success(try attachment(from: url)), completion: completion)
                } catch {
                    complete(.failure(error), completion: completion)
                }
            }
            return
        }

        guard let imageTypeIdentifier = provider.registeredTypeIdentifiers.first(where: {
            UTType($0)?.conforms(to: .image) == true
        }) else {
            complete(.failure(ChatAttachmentImportError.unsupported), completion: completion)
            return
        }

        provider.loadDataRepresentation(forTypeIdentifier: imageTypeIdentifier) { data, error in
            if let error {
                complete(.failure(error), completion: completion)
                return
            }
            guard let data else {
                complete(.failure(ChatAttachmentImportError.unsupported), completion: completion)
                return
            }
            guard data.count <= Int(ChatComposerAttachmentPolicy.maximumImageDataBytes) else {
                complete(.failure(ChatAttachmentImportError.imageTooLarge), completion: completion)
                return
            }

            do {
                let attachment = try persistImageData(data, typeIdentifier: imageTypeIdentifier)
                complete(.success(attachment), completion: completion)
            } catch {
                complete(.failure(error), completion: completion)
            }
        }
    }


    // Internal for testing. Callers should use `load(provider:completion:)`.
    internal func persistImageData(_ data: Data, typeIdentifier: String) throws -> ChatComposerAttachment {
        guard let baseURL = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            throw ChatAttachmentImportError.persistenceFailed
        }

        let directory = baseURL
            .appendingPathComponent("Trinity S3AI", isDirectory: true)
            .appendingPathComponent("Attachments", isDirectory: true)

        do {
            try fileManager.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [FileAttributeKey.posixPermissions: 0o700]
            )
            try Self.excludeFromBackup(directory)

            let type = UTType(typeIdentifier)
            let extensionName = type?.preferredFilenameExtension ?? "png"
            let fileName = "image-\(UUID().uuidString.lowercased()).\(extensionName)"
            let destination = directory.appendingPathComponent(fileName)

            // Validate that the destination stays inside the attachment base
            // directory and does not traverse symlinks into sensitive paths.
            try SafeFilePath.validateWritePath(
                candidate: destination,
                baseURL: directory
            )

            let encrypted = try TriOSEncryption.attachments.encrypt(data)
            try encrypted.write(to: destination, options: [.atomic])
            return ChatComposerAttachment(
                url: destination,
                displayName: fileName,
                kind: .image,
                byteCount: Int64(encrypted.count),
                mediaType: type?.preferredMIMEType,
                isEncrypted: true
            )
        } catch let error as ChatAttachmentImportError {
            throw error
        } catch {
            throw ChatAttachmentImportError.persistenceFailed
        }
    }

    private static func excludeFromBackup(_ url: URL) throws {
        var mutable = url
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        try mutable.setResourceValues(resourceValues)
    }

    private func fileURL(from item: NSSecureCoding?) -> URL? {
        if let url = item as? URL { return url }
        if let url = item as? NSURL { return url as URL }
        if let data = item as? Data {
            let text = String(decoding: data, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return URL(string: text) ?? URL(fileURLWithPath: text)
        }
        if let text = item as? String {
            return URL(string: text) ?? URL(fileURLWithPath: text)
        }
        return nil
    }

    private func complete(
        _ result: Result<ChatComposerAttachment, Error>,
        completion: @escaping (Result<ChatComposerAttachment, Error>) -> Void
    ) {
        DispatchQueue.main.async {
            completion(result)
        }
    }
}
