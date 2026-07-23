import Foundation

enum CodeDiffLineKind: Equatable {
    case fileHeader
    case hunkHeader
    case context
    case addition
    case deletion
    case metadata
}

enum CodeDiffVisualTone: Equatable {
    case neutral
    case green
    case red
    case accent
}

extension CodeDiffLineKind {
    var visualTone: CodeDiffVisualTone {
        switch self {
        case .addition: return .green
        case .deletion: return .red
        case .hunkHeader: return .accent
        case .fileHeader, .context, .metadata: return .neutral
        }
    }
}

struct CodeDiffLine: Equatable {
    let kind: CodeDiffLineKind
    let text: String
    let oldLineNumber: Int?
    let newLineNumber: Int?
}

struct CodeDiffDocument: Equatable {
    let filePath: String?
    let lines: [CodeDiffLine]
    let copyText: String

    var displayPath: String {
        filePath ?? "Code changes"
    }

    var additionCount: Int {
        lines.filter { $0.kind == .addition }.count
    }

    var deletionCount: Int {
        lines.filter { $0.kind == .deletion }.count
    }

    var hasChanges: Bool {
        additionCount > 0 || deletionCount > 0
    }

    func replacingPathIfMissing(_ path: String?) -> CodeDiffDocument {
        guard filePath == nil, let path, !path.isEmpty else { return self }
        return CodeDiffDocument(filePath: path, lines: lines, copyText: copyText)
    }
}

enum CodeDiffParser {
    private static let maximumLCSCells = 250_000

    static func parse(_ source: String) -> CodeDiffDocument? {
        let rawLines = normalizedLines(source)
        guard !rawLines.isEmpty else { return nil }

        let hasGitHeader = rawLines.contains { $0.hasPrefix("diff --git ") }
        let hasApplyPatchHeader = rawLines.contains { line in
            line.hasPrefix("*** Begin Patch") ||
            line.hasPrefix("*** Update File:") ||
            line.hasPrefix("*** Add File:") ||
            line.hasPrefix("*** Delete File:")
        }
        let hasHunkHeader = rawLines.contains { $0.hasPrefix("@@") }
        let hasOldFileHeader = rawLines.contains { $0.hasPrefix("--- ") }
        let hasNewFileHeader = rawLines.contains { $0.hasPrefix("+++ ") }
        let additionCount = rawLines.filter {
            $0.hasPrefix("+") && !$0.hasPrefix("+++")
        }.count
        let deletionCount = rawLines.filter {
            $0.hasPrefix("-") && !$0.hasPrefix("---")
        }.count
        let hasCredibleEnvelope = hasGitHeader || hasApplyPatchHeader || hasHunkHeader ||
            (hasOldFileHeader && hasNewFileHeader)

        guard hasCredibleEnvelope, additionCount + deletionCount > 0 else {
            return nil
        }

        var oldCursor: Int?
        var newCursor: Int?
        var filePath: String?
        var parsedLines: [CodeDiffLine] = []

        for rawLine in rawLines {
            if rawLine.hasPrefix("@@") {
                let starts = hunkStarts(rawLine)
                oldCursor = starts.old
                newCursor = starts.new
                parsedLines.append(
                    CodeDiffLine(
                        kind: .hunkHeader,
                        text: rawLine,
                        oldLineNumber: nil,
                        newLineNumber: nil
                    )
                )
                continue
            }

            if isFileHeader(rawLine) {
                if let detectedPath = detectedFilePath(from: rawLine) {
                    filePath = detectedPath
                }
                parsedLines.append(
                    CodeDiffLine(
                        kind: .fileHeader,
                        text: rawLine,
                        oldLineNumber: nil,
                        newLineNumber: nil
                    )
                )
                continue
            }

            if rawLine.hasPrefix("+") && !rawLine.hasPrefix("+++") {
                if newCursor == nil { newCursor = 1 }
                parsedLines.append(
                    CodeDiffLine(
                        kind: .addition,
                        text: String(rawLine.dropFirst()),
                        oldLineNumber: nil,
                        newLineNumber: newCursor
                    )
                )
                newCursor = (newCursor ?? 0) + 1
                continue
            }

            if rawLine.hasPrefix("-") && !rawLine.hasPrefix("---") {
                if oldCursor == nil { oldCursor = 1 }
                parsedLines.append(
                    CodeDiffLine(
                        kind: .deletion,
                        text: String(rawLine.dropFirst()),
                        oldLineNumber: oldCursor,
                        newLineNumber: nil
                    )
                )
                oldCursor = (oldCursor ?? 0) + 1
                continue
            }

            if rawLine.hasPrefix(" ") {
                if oldCursor == nil { oldCursor = 1 }
                if newCursor == nil { newCursor = 1 }
                parsedLines.append(
                    CodeDiffLine(
                        kind: .context,
                        text: String(rawLine.dropFirst()),
                        oldLineNumber: oldCursor,
                        newLineNumber: newCursor
                    )
                )
                oldCursor = (oldCursor ?? 0) + 1
                newCursor = (newCursor ?? 0) + 1
                continue
            }

            parsedLines.append(
                CodeDiffLine(
                    kind: .metadata,
                    text: rawLine,
                    oldLineNumber: nil,
                    newLineNumber: nil
                )
            )
        }

        return CodeDiffDocument(filePath: filePath, lines: parsedLines, copyText: source)
    }

    static func compare(old: String, new: String, filePath: String? = nil) -> CodeDiffDocument {
        let oldLines = normalizedLines(old)
        let newLines = normalizedLines(new)
        let operations = comparisonOperations(old: oldLines, new: newLines)
        let resolvedPath = filePath?.isEmpty == false ? filePath : nil
        let headerPath = resolvedPath ?? "code"
        var lines: [CodeDiffLine] = [
            CodeDiffLine(kind: .fileHeader, text: "--- \(headerPath)", oldLineNumber: nil, newLineNumber: nil),
            CodeDiffLine(kind: .fileHeader, text: "+++ \(headerPath)", oldLineNumber: nil, newLineNumber: nil),
            CodeDiffLine(
                kind: .hunkHeader,
                text: "@@ -1,\(oldLines.count) +1,\(newLines.count) @@",
                oldLineNumber: nil,
                newLineNumber: nil
            )
        ]

        var oldCursor = 1
        var newCursor = 1
        for operation in operations {
            switch operation {
            case .context(let text):
                lines.append(
                    CodeDiffLine(
                        kind: .context,
                        text: text,
                        oldLineNumber: oldCursor,
                        newLineNumber: newCursor
                    )
                )
                oldCursor += 1
                newCursor += 1
            case .deletion(let text):
                lines.append(
                    CodeDiffLine(
                        kind: .deletion,
                        text: text,
                        oldLineNumber: oldCursor,
                        newLineNumber: nil
                    )
                )
                oldCursor += 1
            case .addition(let text):
                lines.append(
                    CodeDiffLine(
                        kind: .addition,
                        text: text,
                        oldLineNumber: nil,
                        newLineNumber: newCursor
                    )
                )
                newCursor += 1
            }
        }

        let copyText = lines.map { line in
            switch line.kind {
            case .addition: return "+\(line.text)"
            case .deletion: return "-\(line.text)"
            case .context: return " \(line.text)"
            case .fileHeader, .hunkHeader, .metadata: return line.text
            }
        }.joined(separator: "\n")

        return CodeDiffDocument(filePath: resolvedPath, lines: lines, copyText: copyText)
    }

    private enum ComparisonOperation {
        case context(String)
        case addition(String)
        case deletion(String)
    }

    private static func comparisonOperations(old: [String], new: [String]) -> [ComparisonOperation] {
        guard old.isEmpty || new.count <= maximumLCSCells / old.count else {
            return old.map(ComparisonOperation.deletion) + new.map(ComparisonOperation.addition)
        }
        guard old.count * new.count <= maximumLCSCells else {
            return old.map(ComparisonOperation.deletion) + new.map(ComparisonOperation.addition)
        }

        let columnCount = new.count + 1
        var lengths = Array(repeating: 0, count: (old.count + 1) * columnCount)

        if !old.isEmpty && !new.isEmpty {
            for oldIndex in stride(from: old.count - 1, through: 0, by: -1) {
                for newIndex in stride(from: new.count - 1, through: 0, by: -1) {
                    let index = oldIndex * columnCount + newIndex
                    if old[oldIndex] == new[newIndex] {
                        lengths[index] = lengths[(oldIndex + 1) * columnCount + newIndex + 1] + 1
                    } else {
                        lengths[index] = max(
                            lengths[(oldIndex + 1) * columnCount + newIndex],
                            lengths[oldIndex * columnCount + newIndex + 1]
                        )
                    }
                }
            }
        }

        var operations: [ComparisonOperation] = []
        var oldIndex = 0
        var newIndex = 0
        while oldIndex < old.count || newIndex < new.count {
            if oldIndex < old.count,
               newIndex < new.count,
               old[oldIndex] == new[newIndex] {
                operations.append(.context(old[oldIndex]))
                oldIndex += 1
                newIndex += 1
            } else if oldIndex < old.count,
                      (newIndex == new.count ||
                       lengths[(oldIndex + 1) * columnCount + newIndex] >=
                       lengths[oldIndex * columnCount + min(newIndex + 1, new.count)]) {
                operations.append(.deletion(old[oldIndex]))
                oldIndex += 1
            } else if newIndex < new.count {
                operations.append(.addition(new[newIndex]))
                newIndex += 1
            }
        }
        return operations
    }

    private static func normalizedLines(_ source: String) -> [String] {
        let normalized = source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        var lines = normalized.components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        return lines
    }

    private static func hunkStarts(_ line: String) -> (old: Int, new: Int) {
        var oldStart = 1
        var newStart = 1
        for token in line.split(separator: " ") {
            if token.hasPrefix("-"),
               let value = Int(token.dropFirst().split(separator: ",").first ?? "") {
                oldStart = value
            } else if token.hasPrefix("+"),
                      let value = Int(token.dropFirst().split(separator: ",").first ?? "") {
                newStart = value
            }
        }
        return (oldStart, newStart)
    }

    private static func isFileHeader(_ line: String) -> Bool {
        line.hasPrefix("diff --git ") ||
        line.hasPrefix("index ") ||
        line.hasPrefix("--- ") ||
        line.hasPrefix("+++ ") ||
        line.hasPrefix("*** Begin Patch") ||
        line.hasPrefix("*** End Patch") ||
        line.hasPrefix("*** Update File:") ||
        line.hasPrefix("*** Add File:") ||
        line.hasPrefix("*** Delete File:")
    }

    private static func detectedFilePath(from line: String) -> String? {
        let prefixes = ["*** Update File: ", "*** Add File: ", "*** Delete File: "]
        for prefix in prefixes where line.hasPrefix(prefix) {
            return String(line.dropFirst(prefix.count))
        }

        if line.hasPrefix("+++ ") {
            let path = String(line.dropFirst(4)).split(separator: "\t").first.map(String.init) ?? ""
            guard path != "/dev/null" else { return nil }
            return path.hasPrefix("b/") ? String(path.dropFirst(2)) : path
        }
        return nil
    }
}

enum StructuredCodeDiffExtractor {
    static func documents(from node: StructuredDetailNode) -> [CodeDiffDocument] {
        collect(from: node, inheritedPath: nil)
    }

    private static func collect(
        from node: StructuredDetailNode,
        inheritedPath: String?
    ) -> [CodeDiffDocument] {
        switch node {
        case .object(let fields):
            let path = stringValue(forNormalizedKeys: ["path", "filepath", "file", "filename"], in: fields) ?? inheritedPath

            if let patch = stringValue(forNormalizedKeys: ["diff", "patch", "unifieddiff"], in: fields),
               let document = CodeDiffParser.parse(patch) {
                return [document.replacingPathIfMissing(path)]
            }

            let pairs = [
                ("oldstring", "newstring"),
                ("oldtext", "newtext"),
                ("oldcontent", "newcontent"),
                ("before", "after"),
                ("original", "replacement")
            ]
            for pair in pairs {
                if let old = stringValue(forNormalizedKeys: [pair.0], in: fields),
                   let new = stringValue(forNormalizedKeys: [pair.1], in: fields) {
                    let document = CodeDiffParser.compare(old: old, new: new, filePath: path)
                    return document.hasChanges ? [document] : []
                }
            }

            return fields.flatMap { field in
                collect(from: field.value, inheritedPath: path)
            }

        case .array(let values):
            return values.flatMap { collect(from: $0, inheritedPath: inheritedPath) }

        case .string(let value):
            guard let document = CodeDiffParser.parse(value) else { return [] }
            return [document.replacingPathIfMissing(inheritedPath)]

        case .number, .boolean, .null:
            return []
        }
    }

    private static func stringValue(
        forNormalizedKeys keys: Set<String>,
        in fields: [StructuredDetailField]
    ) -> String? {
        for field in fields where keys.contains(normalizedKey(field.key)) {
            if case .string(let value) = field.value {
                return value
            }
        }
        return nil
    }

    private static func normalizedKey(_ key: String) -> String {
        key.lowercased().filter { $0.isLetter || $0.isNumber }
    }
}
