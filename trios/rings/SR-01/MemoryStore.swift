// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: AGENT-MEMORY-TODO-001 adds the durable memory and plan boundary.
// Follow-up: seal against .trinity/specs/agent-memory-todo-planner.md.
import Foundation
import SQLite3

struct AgentMemoryRecord: Identifiable, Codable, Sendable, Equatable {
    let id: UUID
    let conversationId: UUID
    let sourceMessageId: UUID
    let body: String
    let createdAt: Date

    var displayBody: String {
        body
            .components(separatedBy: .newlines)
            .filter { !$0.hasPrefix("Recall: ") }
            .joined(separator: "\n")
    }

    var recallFeatures: [String] {
        body
            .components(separatedBy: .newlines)
            .first(where: { $0.hasPrefix("Recall: ") })
            .map { String($0.dropFirst("Recall: ".count)) }
            .map {
                $0.split(whereSeparator: \.isWhitespace).map(String.init)
            }
            ?? []
    }
}

struct AgentMemoryMatch: Identifiable, Sendable, Equatable {
    var id: UUID { record.id }
    let record: AgentMemoryRecord
    let score: Double
}

protocol AgentMemoryStoreProtocol: Sendable {
    func saveMemory(_ record: AgentMemoryRecord) async throws
    func memoryCandidates(
        for query: String,
        limit: Int
    ) async throws -> [AgentMemoryRecord]
    func recentMemories(limit: Int) async throws -> [AgentMemoryRecord]
    func deleteMemory(id: UUID) async throws -> Bool
    func deleteMemories(conversationId: UUID) async throws -> Int
    func savePlan(_ plan: TODOPlan) async throws
    func loadPlan(conversationId: UUID) async throws -> TODOPlan?
    func deletePlan(conversationId: UUID) async throws
    func deleteConversationData(conversationId: UUID) async throws
}

enum MemoryStoreError: LocalizedError {
    case openFailed(String)
    case sqlite(operation: String, message: String)
    case unsupportedSchema(Int)
    case corruptRecord(String)

    var errorDescription: String? {
        switch self {
        case .openFailed(let message):
            return "Unable to open agent memory: \(message)"
        case .sqlite(let operation, let message):
            return "Agent memory \(operation) failed: \(message)"
        case .unsupportedSchema(let version):
            return "Agent memory schema \(version) is newer than this application"
        case .corruptRecord(let message):
            return "Agent memory contains an invalid record: \(message)"
        }
    }
}

actor MemoryStore: AgentMemoryStoreProtocol {
    private enum SQLiteValue {
        case text(String)
        case double(Double)
        case integer(Int64)
        case null
    }

    private static let schemaVersionNumber = 1
    private static let candidateLimit = 64
    private static let transientDestructor = unsafeBitCast(
        -1,
        to: sqlite3_destructor_type.self
    )

    private var database: OpaquePointer?

    init(databaseURL: URL = MemoryStore.defaultDatabaseURL()) throws {
        let parentURL = databaseURL.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: parentURL,
                withIntermediateDirectories: true
            )
        } catch {
            throw MemoryStoreError.openFailed(error.localizedDescription)
        }

        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_CREATE
            | SQLITE_OPEN_READWRITE
            | SQLITE_OPEN_FULLMUTEX
        let result = sqlite3_open_v2(databaseURL.path, &handle, flags, nil)
        guard result == SQLITE_OK, let handle else {
            let message = handle
                .flatMap { sqlite3_errmsg($0) }
                .map { String(cString: $0) }
                ?? "unknown SQLite error"
            if let handle {
                sqlite3_close_v2(handle)
            }
            throw MemoryStoreError.openFailed(message)
        }
        database = handle

        do {
            try Self.configure(handle)
            try Self.migrate(handle)
        } catch {
            sqlite3_close_v2(handle)
            database = nil
            throw error
        }
    }

    deinit {
        if let database {
            sqlite3_close_v2(database)
        }
    }

    static func defaultDatabaseURL() -> URL {
        let support = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
        return support
            .appendingPathComponent("Trinity S3AI", isDirectory: true)
            .appendingPathComponent("AgentMemory", isDirectory: true)
            .appendingPathComponent("agent-memory.sqlite3")
    }

    func schemaVersion() async -> Int {
        guard let database else { return 0 }
        return (try? Self.pragmaInteger(database, name: "user_version")) ?? 0
    }

    func journalMode() async -> String {
        guard let database else { return "" }
        return (try? Self.pragmaText(database, name: "journal_mode"))?
            .lowercased() ?? ""
    }

    func close() {
        guard let database else { return }
        sqlite3_close_v2(database)
        self.database = nil
    }

    func saveMemory(_ record: AgentMemoryRecord) async throws {
        let database = try openDatabase()
        try Self.withTransaction(database) {
            try Self.execute(
                database,
                sql: """
                    INSERT INTO memories (
                        id,
                        conversation_id,
                        source_message_id,
                        body,
                        created_at
                    ) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(source_message_id) DO UPDATE SET
                        id = excluded.id,
                        conversation_id = excluded.conversation_id,
                        body = excluded.body,
                        created_at = excluded.created_at
                    """,
                bindings: [
                    .text(record.id.uuidString),
                    .text(record.conversationId.uuidString),
                    .text(record.sourceMessageId.uuidString),
                    .text(record.body),
                    .double(record.createdAt.timeIntervalSince1970)
                ]
            )
        }
    }

    func memoryCandidates(
        for query: String,
        limit: Int
    ) async throws -> [AgentMemoryRecord] {
        let database = try openDatabase()
        let boundedLimit = max(1, min(limit, Self.candidateLimit))
        var records: [AgentMemoryRecord] = []
        var seen = Set<UUID>()

        if let matchExpression = Self.ftsMatchExpression(for: query) {
            let statement = try Self.prepare(
                database,
                sql: """
                    SELECT
                        m.id,
                        m.conversation_id,
                        m.source_message_id,
                        m.body,
                        m.created_at
                    FROM memories_fts
                    JOIN memories AS m ON m.rowid = memories_fts.rowid
                    WHERE memories_fts MATCH ?
                    ORDER BY
                        bm25(memories_fts) ASC,
                        m.created_at DESC,
                        m.id ASC
                    LIMIT ?
                    """
            )
            defer { sqlite3_finalize(statement) }
            try Self.bind(
                [.text(matchExpression), .integer(Int64(boundedLimit))],
                to: statement,
                database: database
            )
            while sqlite3_step(statement) == SQLITE_ROW {
                let record = try Self.decodeMemory(statement)
                if seen.insert(record.id).inserted {
                    records.append(record)
                }
            }
            try Self.verifyStepCompletion(statement, database: database)
        }

        if records.count < boundedLimit {
            let statement = try Self.prepare(
                database,
                sql: """
                    SELECT
                        id,
                        conversation_id,
                        source_message_id,
                        body,
                        created_at
                    FROM memories
                    ORDER BY created_at DESC, id ASC
                    LIMIT ?
                    """
            )
            defer { sqlite3_finalize(statement) }
            try Self.bind(
                [.integer(Int64(boundedLimit))],
                to: statement,
                database: database
            )
            while sqlite3_step(statement) == SQLITE_ROW {
                let record = try Self.decodeMemory(statement)
                if seen.insert(record.id).inserted {
                    records.append(record)
                }
                if records.count == boundedLimit {
                    break
                }
            }
            try Self.verifyStepCompletion(statement, database: database)
        }

        return records
    }

    func recentMemories(limit: Int) async throws -> [AgentMemoryRecord] {
        let boundedLimit = max(0, min(limit, Self.candidateLimit))
        guard boundedLimit > 0 else { return [] }

        let database = try openDatabase()
        let statement = try Self.prepare(
            database,
            sql: """
                SELECT
                    id,
                    conversation_id,
                    source_message_id,
                    body,
                    created_at
                FROM memories
                ORDER BY created_at DESC, id ASC
                LIMIT ?
                """
        )
        defer { sqlite3_finalize(statement) }
        try Self.bind(
            [.integer(Int64(boundedLimit))],
            to: statement,
            database: database
        )

        var records: [AgentMemoryRecord] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            records.append(try Self.decodeMemory(statement))
        }
        try Self.verifyStepCompletion(statement, database: database)
        return records
    }

    func deleteMemory(id: UUID) async throws -> Bool {
        let database = try openDatabase()
        return try Self.withTransaction(database) {
            try Self.execute(
                database,
                sql: "DELETE FROM memories WHERE id = ?",
                bindings: [.text(id.uuidString)]
            )
            return sqlite3_changes(database) > 0
        }
    }

    func deleteMemories(conversationId: UUID) async throws -> Int {
        let database = try openDatabase()
        return try Self.withTransaction(database) {
            try Self.execute(
                database,
                sql: "DELETE FROM memories WHERE conversation_id = ?",
                bindings: [.text(conversationId.uuidString)]
            )
            return Int(sqlite3_changes(database))
        }
    }

    func savePlan(_ plan: TODOPlan) async throws {
        let database = try openDatabase()
        try Self.withTransaction(database) {
            try Self.execute(
                database,
                sql: "DELETE FROM plans WHERE conversation_id = ?",
                bindings: [.text(plan.conversationId.uuidString)]
            )
            try Self.execute(
                database,
                sql: """
                    INSERT INTO plans (
                        id,
                        conversation_id,
                        goal,
                        state,
                        created_at,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                bindings: [
                    .text(plan.id.uuidString),
                    .text(plan.conversationId.uuidString),
                    .text(plan.goal),
                    .text(plan.state.rawValue),
                    .double(plan.createdAt.timeIntervalSince1970),
                    .double(plan.updatedAt.timeIntervalSince1970)
                ]
            )
            for item in plan.items.sorted(by: {
                if $0.order == $1.order {
                    return $0.id.uuidString < $1.id.uuidString
                }
                return $0.order < $1.order
            }) {
                try Self.execute(
                    database,
                    sql: """
                        INSERT INTO plan_items (
                            id,
                            plan_id,
                            title,
                            detail,
                            state,
                            item_order
                        ) VALUES (?, ?, ?, ?, ?, ?)
                        """,
                    bindings: [
                        .text(item.id.uuidString),
                        .text(plan.id.uuidString),
                        .text(item.title),
                        item.detail.map(SQLiteValue.text) ?? .null,
                        .text(item.state.rawValue),
                        .integer(Int64(item.order))
                    ]
                )
            }
        }
    }

    func loadPlan(conversationId: UUID) async throws -> TODOPlan? {
        let database = try openDatabase()
        let planStatement = try Self.prepare(
            database,
            sql: """
                SELECT id, goal, state, created_at, updated_at
                FROM plans
                WHERE conversation_id = ?
                LIMIT 1
                """
        )
        defer { sqlite3_finalize(planStatement) }
        try Self.bind(
            [.text(conversationId.uuidString)],
            to: planStatement,
            database: database
        )

        let step = sqlite3_step(planStatement)
        if step == SQLITE_DONE {
            return nil
        }
        guard step == SQLITE_ROW else {
            throw Self.sqliteError(database, operation: "load plan")
        }

        guard
            let id = Self.uuidColumn(planStatement, index: 0),
            let goal = Self.stringColumn(planStatement, index: 1),
            let rawState = Self.stringColumn(planStatement, index: 2),
            let state = TODOPlanState(rawValue: rawState)
        else {
            throw MemoryStoreError.corruptRecord("invalid plan fields")
        }
        let createdAt = Date(
            timeIntervalSince1970: sqlite3_column_double(planStatement, 3)
        )
        let updatedAt = Date(
            timeIntervalSince1970: sqlite3_column_double(planStatement, 4)
        )

        let itemStatement = try Self.prepare(
            database,
            sql: """
                SELECT id, title, detail, state, item_order
                FROM plan_items
                WHERE plan_id = ?
                ORDER BY item_order ASC, id ASC
                """
        )
        defer { sqlite3_finalize(itemStatement) }
        try Self.bind(
            [.text(id.uuidString)],
            to: itemStatement,
            database: database
        )

        var items: [TODOItem] = []
        while sqlite3_step(itemStatement) == SQLITE_ROW {
            guard
                let itemId = Self.uuidColumn(itemStatement, index: 0),
                let title = Self.stringColumn(itemStatement, index: 1),
                let rawItemState = Self.stringColumn(itemStatement, index: 3),
                let itemState = TODOItemState(rawValue: rawItemState)
            else {
                throw MemoryStoreError.corruptRecord("invalid plan item fields")
            }
            let detail = Self.stringColumn(itemStatement, index: 2)
            let order = Int(sqlite3_column_int64(itemStatement, 4))
            items.append(
                TODOItem(
                    id: itemId,
                    title: title,
                    detail: detail,
                    state: itemState,
                    order: order
                )
            )
        }
        try Self.verifyStepCompletion(itemStatement, database: database)

        return TODOPlan(
            id: id,
            conversationId: conversationId,
            goal: goal,
            state: state,
            items: items,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }

    func deletePlan(conversationId: UUID) async throws {
        let database = try openDatabase()
        try Self.execute(
            database,
            sql: "DELETE FROM plans WHERE conversation_id = ?",
            bindings: [.text(conversationId.uuidString)]
        )
    }

    func deleteConversationData(conversationId: UUID) async throws {
        let database = try openDatabase()
        try Self.withTransaction(database) {
            let id = conversationId.uuidString
            try Self.execute(
                database,
                sql: "DELETE FROM plans WHERE conversation_id = ?",
                bindings: [.text(id)]
            )
            try Self.execute(
                database,
                sql: "DELETE FROM memories WHERE conversation_id = ?",
                bindings: [.text(id)]
            )
        }
    }

    private func openDatabase() throws -> OpaquePointer {
        guard let database else {
            throw MemoryStoreError.openFailed("the database is closed")
        }
        return database
    }

    private static func configure(_ database: OpaquePointer) throws {
        guard sqlite3_busy_timeout(database, 5_000) == SQLITE_OK else {
            throw sqliteError(database, operation: "set busy timeout")
        }
        try execute(database, sql: "PRAGMA foreign_keys = ON")
        _ = try pragmaText(database, name: "journal_mode", value: "WAL")
        try execute(database, sql: "PRAGMA synchronous = NORMAL")
    }

    private static func migrate(_ database: OpaquePointer) throws {
        let version = try pragmaInteger(database, name: "user_version")
        guard version <= schemaVersionNumber else {
            throw MemoryStoreError.unsupportedSchema(version)
        }
        guard version == 0 else { return }

        try withTransaction(database) {
            try execute(
                database,
                sql: """
                    CREATE TABLE memories (
                        id TEXT PRIMARY KEY NOT NULL,
                        conversation_id TEXT NOT NULL,
                        source_message_id TEXT NOT NULL UNIQUE,
                        body TEXT NOT NULL,
                        created_at REAL NOT NULL
                    );

                    CREATE VIRTUAL TABLE memories_fts USING fts5(
                        body,
                        content = 'memories',
                        content_rowid = 'rowid',
                        tokenize = 'unicode61 remove_diacritics 2'
                    );

                    CREATE TRIGGER memories_after_insert
                    AFTER INSERT ON memories BEGIN
                        INSERT INTO memories_fts(rowid, body)
                        VALUES (new.rowid, new.body);
                    END;

                    CREATE TRIGGER memories_after_delete
                    AFTER DELETE ON memories BEGIN
                        INSERT INTO memories_fts(memories_fts, rowid, body)
                        VALUES ('delete', old.rowid, old.body);
                    END;

                    CREATE TRIGGER memories_after_update
                    AFTER UPDATE ON memories BEGIN
                        INSERT INTO memories_fts(memories_fts, rowid, body)
                        VALUES ('delete', old.rowid, old.body);
                        INSERT INTO memories_fts(rowid, body)
                        VALUES (new.rowid, new.body);
                    END;

                    CREATE TABLE plans (
                        id TEXT PRIMARY KEY NOT NULL,
                        conversation_id TEXT NOT NULL UNIQUE,
                        goal TEXT NOT NULL,
                        state TEXT NOT NULL,
                        created_at REAL NOT NULL,
                        updated_at REAL NOT NULL
                    );

                    CREATE TABLE plan_items (
                        id TEXT PRIMARY KEY NOT NULL,
                        plan_id TEXT NOT NULL,
                        title TEXT NOT NULL,
                        detail TEXT,
                        state TEXT NOT NULL,
                        item_order INTEGER NOT NULL,
                        FOREIGN KEY(plan_id) REFERENCES plans(id)
                            ON DELETE CASCADE
                    );

                    CREATE INDEX plan_items_plan_order
                    ON plan_items(plan_id, item_order);

                    PRAGMA user_version = 1;
                    """
            )
        }
    }

    private static func execute(
        _ database: OpaquePointer,
        sql: String,
        bindings: [SQLiteValue] = []
    ) throws {
        if bindings.isEmpty {
            var errorPointer: UnsafeMutablePointer<CChar>?
            let result = sqlite3_exec(
                database,
                sql,
                nil,
                nil,
                &errorPointer
            )
            guard result == SQLITE_OK else {
                let message = errorPointer
                    .map { String(cString: $0) }
                    ?? errorMessage(database)
                sqlite3_free(errorPointer)
                throw MemoryStoreError.sqlite(
                    operation: "execute statement",
                    message: message
                )
            }
            return
        }

        let statement = try prepare(database, sql: sql)
        defer { sqlite3_finalize(statement) }
        try bind(bindings, to: statement, database: database)
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw sqliteError(database, operation: "execute statement")
        }
    }

    private static func prepare(
        _ database: OpaquePointer,
        sql: String
    ) throws -> OpaquePointer {
        var statement: OpaquePointer?
        let result = sqlite3_prepare_v2(database, sql, -1, &statement, nil)
        guard result == SQLITE_OK, let statement else {
            throw sqliteError(database, operation: "prepare statement")
        }
        return statement
    }

    private static func bind(
        _ values: [SQLiteValue],
        to statement: OpaquePointer,
        database: OpaquePointer
    ) throws {
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let result: Int32
            switch value {
            case .text(let text):
                result = sqlite3_bind_text(
                    statement,
                    index,
                    text,
                    -1,
                    transientDestructor
                )
            case .double(let number):
                result = sqlite3_bind_double(statement, index, number)
            case .integer(let number):
                result = sqlite3_bind_int64(statement, index, number)
            case .null:
                result = sqlite3_bind_null(statement, index)
            }
            guard result == SQLITE_OK else {
                throw sqliteError(database, operation: "bind statement")
            }
        }
    }

    private static func withTransaction<T>(
        _ database: OpaquePointer,
        operation: () throws -> T
    ) throws -> T {
        try execute(database, sql: "BEGIN IMMEDIATE")
        do {
            let result = try operation()
            try execute(database, sql: "COMMIT")
            return result
        } catch {
            try? execute(database, sql: "ROLLBACK")
            throw error
        }
    }

    private static func pragmaInteger(
        _ database: OpaquePointer,
        name: String
    ) throws -> Int {
        let statement = try prepare(database, sql: "PRAGMA \(name)")
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else {
            throw sqliteError(database, operation: "read pragma \(name)")
        }
        return Int(sqlite3_column_int64(statement, 0))
    }

    private static func pragmaText(
        _ database: OpaquePointer,
        name: String,
        value: String? = nil
    ) throws -> String {
        let suffix = value.map { " = \($0)" } ?? ""
        let statement = try prepare(
            database,
            sql: "PRAGMA \(name)\(suffix)"
        )
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW,
              let text = sqlite3_column_text(statement, 0) else {
            throw sqliteError(database, operation: "read pragma \(name)")
        }
        return String(cString: text)
    }

    private static func decodeMemory(
        _ statement: OpaquePointer
    ) throws -> AgentMemoryRecord {
        guard
            let id = uuidColumn(statement, index: 0),
            let conversationId = uuidColumn(statement, index: 1),
            let sourceMessageId = uuidColumn(statement, index: 2),
            let body = stringColumn(statement, index: 3)
        else {
            throw MemoryStoreError.corruptRecord("invalid memory fields")
        }
        return AgentMemoryRecord(
            id: id,
            conversationId: conversationId,
            sourceMessageId: sourceMessageId,
            body: body,
            createdAt: Date(
                timeIntervalSince1970: sqlite3_column_double(statement, 4)
            )
        )
    }

    private static func stringColumn(
        _ statement: OpaquePointer,
        index: Int32
    ) -> String? {
        guard sqlite3_column_type(statement, index) != SQLITE_NULL,
              let text = sqlite3_column_text(statement, index) else {
            return nil
        }
        return String(cString: text)
    }

    private static func uuidColumn(
        _ statement: OpaquePointer,
        index: Int32
    ) -> UUID? {
        stringColumn(statement, index: index).flatMap(UUID.init(uuidString:))
    }

    private static func verifyStepCompletion(
        _ statement: OpaquePointer,
        database: OpaquePointer
    ) throws {
        let result = sqlite3_errcode(database)
        if result != SQLITE_OK, result != SQLITE_DONE, result != SQLITE_ROW {
            throw sqliteError(database, operation: "read rows")
        }
        _ = statement
    }

    private static func ftsMatchExpression(for query: String) -> String? {
        let tokens = query
            .lowercased()
            .unicodeScalars
            .map { scalar -> String in
                CharacterSet.alphanumerics.contains(scalar)
                    ? String(scalar)
                    : " "
            }
            .joined()
            .split(whereSeparator: \.isWhitespace)
            .map(String.init)
            .filter { !$0.isEmpty }
            .prefix(12)
        guard !tokens.isEmpty else { return nil }
        return tokens
            .map { "\"\($0.replacingOccurrences(of: "\"", with: "\"\""))\"*" }
            .joined(separator: " OR ")
    }

    private static func sqliteError(
        _ database: OpaquePointer,
        operation: String
    ) -> MemoryStoreError {
        .sqlite(operation: operation, message: errorMessage(database))
    }

    private static func errorMessage(_ database: OpaquePointer) -> String {
        sqlite3_errmsg(database)
            .map { String(cString: $0) }
            ?? "unknown SQLite error"
    }
}

actor VolatileMemoryStore: AgentMemoryStoreProtocol {
    private var memories: [UUID: AgentMemoryRecord] = [:]
    private var plans: [UUID: TODOPlan] = [:]

    func saveMemory(_ record: AgentMemoryRecord) async throws {
        if let duplicate = memories.values.first(where: {
            $0.sourceMessageId == record.sourceMessageId
        }) {
            memories.removeValue(forKey: duplicate.id)
        }
        memories[record.id] = record
    }

    func memoryCandidates(
        for query: String,
        limit: Int
    ) async throws -> [AgentMemoryRecord] {
        let boundedLimit = max(1, min(limit, 64))
        return memories.values
            .sorted {
                if $0.createdAt == $1.createdAt {
                    return $0.id.uuidString < $1.id.uuidString
                }
                return $0.createdAt > $1.createdAt
            }
            .prefix(boundedLimit)
            .map { $0 }
    }

    func recentMemories(limit: Int) async throws -> [AgentMemoryRecord] {
        let boundedLimit = max(0, min(limit, 64))
        guard boundedLimit > 0 else { return [] }
        return memories.values
            .sorted {
                if $0.createdAt == $1.createdAt {
                    return $0.id.uuidString < $1.id.uuidString
                }
                return $0.createdAt > $1.createdAt
            }
            .prefix(boundedLimit)
            .map { $0 }
    }

    func deleteMemory(id: UUID) async throws -> Bool {
        memories.removeValue(forKey: id) != nil
    }

    func deleteMemories(conversationId: UUID) async throws -> Int {
        let memoryIds = memories.values.compactMap { record in
            record.conversationId == conversationId ? record.id : nil
        }
        for id in memoryIds {
            memories.removeValue(forKey: id)
        }
        return memoryIds.count
    }

    func savePlan(_ plan: TODOPlan) async throws {
        plans[plan.conversationId] = plan
    }

    func loadPlan(conversationId: UUID) async throws -> TODOPlan? {
        plans[conversationId]
    }

    func deletePlan(conversationId: UUID) async throws {
        plans.removeValue(forKey: conversationId)
    }

    func deleteConversationData(conversationId: UUID) async throws {
        memories = memories.filter {
            $0.value.conversationId != conversationId
        }
        plans.removeValue(forKey: conversationId)
    }
}
