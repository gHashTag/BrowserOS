import Foundation

enum MarkdownTableAlignment: String, Equatable {
    case leading
    case center
    case trailing
}

struct MarkdownTable: Equatable {
    let headers: [String]
    let alignments: [MarkdownTableAlignment]
    let rows: [[String]]

    var columnCount: Int { headers.count }
}

enum MarkdownBlockKind: Equatable {
    case paragraph(String)
    case code(language: String?, content: String)
    case heading(level: Int, content: String)
    case list(ordered: Bool, items: [String])
    case table(MarkdownTable)
    case thematicBreak
    case quote(String)
}

struct MarkdownBlock: Identifiable, Equatable {
    let id: String
    let kind: MarkdownBlockKind
}

enum MarkdownBlockParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        let lines = source.components(separatedBy: .newlines)
        var blocks: [MarkdownBlock] = []
        var index = 0

        while index < lines.count {
            if lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                index += 1
                continue
            }

            let start = index
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") {
                let languageText = String(trimmed.dropFirst(3))
                    .trimmingCharacters(in: .whitespaces)
                var codeLines: [String] = []
                index += 1
                while index < lines.count {
                    if lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                        index += 1
                        break
                    }
                    codeLines.append(lines[index])
                    index += 1
                }
                blocks.append(block(
                    start: start,
                    tag: "code",
                    kind: .code(
                        language: languageText.isEmpty ? nil : languageText,
                        content: codeLines.joined(separator: "\n")
                    )
                ))
                continue
            }

            if let heading = heading(from: trimmed) {
                blocks.append(block(
                    start: start,
                    tag: "heading-\(heading.level)",
                    kind: .heading(level: heading.level, content: heading.content)
                ))
                index += 1
                continue
            }

            if let table = table(at: index, lines: lines) {
                blocks.append(block(start: start, tag: "table", kind: .table(table.value)))
                index = table.nextIndex
                continue
            }

            if isThematicBreak(trimmed) {
                blocks.append(block(start: start, tag: "break", kind: .thematicBreak))
                index += 1
                continue
            }

            if quoteContent(from: trimmed) != nil {
                var quoteLines: [String] = []
                while index < lines.count,
                      let content = quoteContent(
                        from: lines[index].trimmingCharacters(in: .whitespaces)
                      ) {
                    quoteLines.append(content)
                    index += 1
                }
                blocks.append(block(
                    start: start,
                    tag: "quote",
                    kind: .quote(quoteLines.joined(separator: "\n"))
                ))
                continue
            }

            if let firstItem = listItem(from: trimmed) {
                var items: [String] = []
                while index < lines.count,
                      let item = listItem(
                        from: lines[index].trimmingCharacters(in: .whitespaces)
                      ),
                      item.ordered == firstItem.ordered {
                    items.append(item.content)
                    index += 1
                }
                blocks.append(block(
                    start: start,
                    tag: firstItem.ordered ? "ordered-list" : "unordered-list",
                    kind: .list(ordered: firstItem.ordered, items: items)
                ))
                continue
            }

            var paragraphLines: [String] = []
            while index < lines.count {
                let current = lines[index]
                let currentTrimmed = current.trimmingCharacters(in: .whitespaces)
                if currentTrimmed.isEmpty || isBlockStart(at: index, lines: lines) {
                    break
                }
                paragraphLines.append(current)
                index += 1
            }
            if paragraphLines.isEmpty {
                paragraphLines.append(line)
                index += 1
            }
            blocks.append(block(
                start: start,
                tag: "paragraph",
                kind: .paragraph(paragraphLines.joined(separator: "\n"))
            ))
        }

        return blocks
    }

    static func splitTableRow(_ line: String) -> [String] {
        var cells: [String] = []
        var cell = ""
        var inCode = false
        var escaped = false

        for character in line {
            if escaped {
                if character == "|" || character == "\\" {
                    cell.append(character)
                } else {
                    cell.append("\\")
                    cell.append(character)
                }
                escaped = false
                continue
            }
            if character == "\\" {
                escaped = true
                continue
            }
            if character == "`" {
                inCode.toggle()
                cell.append(character)
                continue
            }
            if character == "|" && !inCode {
                cells.append(cell.trimmingCharacters(in: .whitespaces))
                cell = ""
            } else {
                cell.append(character)
            }
        }
        if escaped { cell.append("\\") }
        cells.append(cell.trimmingCharacters(in: .whitespaces))

        if cells.first?.isEmpty == true { cells.removeFirst() }
        if cells.last?.isEmpty == true { cells.removeLast() }
        return cells
    }

    private static func block(start: Int, tag: String, kind: MarkdownBlockKind) -> MarkdownBlock {
        MarkdownBlock(id: "line-\(start)-\(tag)", kind: kind)
    }

    private static func heading(from line: String) -> (level: Int, content: String)? {
        var level = 0
        for character in line {
            if character == "#" { level += 1 } else { break }
        }
        guard (1...6).contains(level) else { return nil }
        let remainder = String(line.dropFirst(level))
        guard remainder.first == " " else { return nil }
        return (level, remainder.trimmingCharacters(in: .whitespaces))
    }

    private static func table(
        at index: Int,
        lines: [String]
    ) -> (value: MarkdownTable, nextIndex: Int)? {
        guard index + 1 < lines.count, lines[index].contains("|") else { return nil }
        let headers = splitTableRow(lines[index])
        let delimiters = splitTableRow(lines[index + 1])
        guard !headers.isEmpty, headers.count == delimiters.count else { return nil }

        var alignments: [MarkdownTableAlignment] = []
        for delimiter in delimiters {
            guard delimiter.range(
                of: "^:?-{3,}:?$",
                options: .regularExpression
            ) != nil else { return nil }
            if delimiter.hasPrefix(":") && delimiter.hasSuffix(":") {
                alignments.append(.center)
            } else if delimiter.hasSuffix(":") {
                alignments.append(.trailing)
            } else {
                alignments.append(.leading)
            }
        }

        var rows: [[String]] = []
        var next = index + 2
        while next < lines.count {
            let candidate = lines[next]
            if candidate.trimmingCharacters(in: .whitespaces).isEmpty || !candidate.contains("|") {
                break
            }
            var cells = splitTableRow(candidate)
            if cells.count < headers.count {
                cells.append(contentsOf: repeatElement("", count: headers.count - cells.count))
            } else if cells.count > headers.count {
                cells = Array(cells.prefix(headers.count))
            }
            rows.append(cells)
            next += 1
        }

        return (MarkdownTable(headers: headers, alignments: alignments, rows: rows), next)
    }

    private static func isThematicBreak(_ line: String) -> Bool {
        let compact = line.filter { !$0.isWhitespace }
        guard compact.count >= 3, let marker = compact.first,
              marker == "-" || marker == "*" || marker == "_" else { return false }
        return compact.allSatisfy { $0 == marker }
    }

    private static func quoteContent(from line: String) -> String? {
        guard line.hasPrefix(">") else { return nil }
        return String(line.dropFirst()).trimmingCharacters(in: .whitespaces)
    }

    private static func listItem(from line: String) -> (ordered: Bool, content: String)? {
        if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
            return (false, String(line.dropFirst(2)))
        }
        guard let range = line.range(
            of: "^[0-9]+[.)][ \\t]+",
            options: .regularExpression
        ) else { return nil }
        return (true, String(line[range.upperBound...]))
    }

    private static func isBlockStart(at index: Int, lines: [String]) -> Bool {
        let line = lines[index].trimmingCharacters(in: .whitespaces)
        return line.hasPrefix("```") ||
            heading(from: line) != nil ||
            table(at: index, lines: lines) != nil ||
            isThematicBreak(line) ||
            quoteContent(from: line) != nil ||
            listItem(from: line) != nil
    }
}
