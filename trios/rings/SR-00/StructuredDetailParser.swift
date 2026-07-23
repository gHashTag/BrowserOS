import Foundation

struct StructuredDetailField: Equatable {
    let key: String
    let value: StructuredDetailNode
}

indirect enum StructuredDetailNode: Equatable {
    case object([StructuredDetailField])
    case array([StructuredDetailNode])
    case string(String)
    case number(String)
    case boolean(Bool)
    case null
}

enum StructuredDetailParser {
    static func parse(_ rawValue: String) -> StructuredDetailNode {
        parseJSON(rawValue, depth: 0) ?? .string(decodeCommonEscapes(rawValue))
    }

    private static func parseJSON(_ source: String, depth: Int) -> StructuredDetailNode? {
        guard depth <= 3,
              let data = source.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) else {
            return nil
        }
        return makeNode(from: value, depth: depth)
    }

    private static func makeNode(from value: Any, depth: Int) -> StructuredDetailNode {
        if let dictionary = value as? [String: Any] {
            let fields = dictionary.keys.sorted().map { key in
                StructuredDetailField(key: key, value: makeNode(from: dictionary[key] as Any, depth: depth + 1))
            }
            return .object(fields)
        }

        if let values = value as? [Any] {
            return .array(values.map { makeNode(from: $0, depth: depth + 1) })
        }

        if let string = value as? String {
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            if depth < 3,
               (trimmed.hasPrefix("{") || trimmed.hasPrefix("[")),
               let nested = parseJSON(trimmed, depth: depth + 1) {
                return nested
            }
            return .string(string)
        }

        if let boolean = value as? Bool {
            return .boolean(boolean)
        }

        if let number = value as? NSNumber {
            return .number(number.stringValue)
        }

        if value is NSNull {
            return .null
        }

        return .string(String(describing: value))
    }

    private static func decodeCommonEscapes(_ source: String) -> String {
        source
            .replacingOccurrences(of: "\\r\\n", with: "\n")
            .replacingOccurrences(of: "\\n", with: "\n")
            .replacingOccurrences(of: "\\r", with: "\n")
            .replacingOccurrences(of: "\\t", with: "\t")
            .replacingOccurrences(of: "\\\"", with: "\"")
            .replacingOccurrences(of: "\\\\", with: "\\")
    }
}
