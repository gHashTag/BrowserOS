//
//  AnalyticsService.swift
//  TriOS — Usage Analytics & Crash Reporting
//
//  Tracks user behavior, performance metrics, and errors
//

import Foundation

/// AnalyticsService — Privacy-first usage analytics
@MainActor
class AnalyticsService {
    
    static let shared = AnalyticsService()
    
    @Published var isEnabled: Bool = true
    @Published var sessionCount: Int = 0
    @Published var totalUsageTime: TimeInterval = 0
    
    private let apiKey: String
    private let apiEndpoint: String
    private var sessionStart: Date?
    private var eventQueue: [AnalyticsEvent] = []
    
    init(apiKey: String = "", apiEndpoint: String = "https://analytics.trios.ai") {
        self.apiKey = apiKey
        self.apiEndpoint = apiEndpoint
        loadSessionData()
    }
    
    // MARK: - Public API
    
    /// Track custom event
    func track(_ event: String, properties: [String: Any]? = nil) {
        guard isEnabled else { return }
        
        let analyticsEvent = AnalyticsEvent(
            id: UUID(),
            timestamp: Date(),
            event: event,
            properties: properties ?? [:],
            sessionId: getCurrentSessionId(),
            userId: getAnonymousUserId()
        )
        
        eventQueue.append(analyticsEvent)
        
        // Batch send every 10 events
        if eventQueue.count >= 10 {
            Task { await flushEvents() }
        }
    }
    
    /// Track screen view
    func trackScreen(_ screenName: String) {
        track("screen_view", properties: ["screen_name": screenName])
    }
    
    /// Track user action
    func trackAction(_ actionName: String, metadata: [String: Any]? = nil) {
        track("user_action", properties: [
            "action_name": actionName,
            "metadata": metadata ?? [:]
        ])
    }
    
    /// Track error
    func trackError(_ error: Error, context: String) {
        track("error", properties: [
            "error_type": String(describing: type(of: error)),
            "error_message": error.localizedDescription,
            "context": context
        ])
    }
    
    /// Track performance metric
    func trackPerformance(metric: String, value: Double, unit: String) {
        track("performance", properties: [
            "metric": metric,
            "value": value,
            "unit": unit
        ])
    }
    
    /// Start session
    func startSession() {
        sessionStart = Date()
        sessionCount += 1
        saveSessionData()
        track("session_start", properties: ["session_count": sessionCount])
    }
    
    /// End session
    func endSession() {
        guard let start = sessionStart else { return }
        let duration = Date().timeIntervalSince(start)
        totalUsageTime += duration
        saveSessionData()
        track("session_end", properties: [
            "duration": duration,
            "total_usage_time": totalUsageTime
        ])
        Task { await flushEvents() }
    }
    
    // MARK: - Private Methods
    
    private func flushEvents() async {
        guard !eventQueue.isEmpty else { return }
        let eventsToSend = eventQueue
        eventQueue.removeAll()
        
        // Send to analytics endpoint
        // Implementation depends on backend
        print("[Analytics] Sending \(eventsToSend.count) events...")
    }
    
    private func getCurrentSessionId() -> String {
        UUID().uuidString
    }
    
    private func getAnonymousUserId() -> String {
        // Generate anonymous user ID on first run
        let key = "trios_anonymous_user_id"
        if let existing = UserDefaults.standard.string(forKey: key) {
            return existing
        }
        let newId = UUID().uuidString
        UserDefaults.standard.set(newId, forKey: key)
        return newId
    }
    
    private func loadSessionData() {
        sessionCount = UserDefaults.standard.integer(forKey: "trios_session_count")
        totalUsageTime = UserDefaults.standard.double(forKey: "trios_total_usage_time")
    }
    
    private func saveSessionData() {
        UserDefaults.standard.set(sessionCount, forKey: "trios_session_count")
        UserDefaults.standard.set(totalUsageTime, forKey: "trios_total_usage_time")
    }
}

// MARK: - Models

/// Encodable, not Codable: `properties` is `[String: Any]`, which cannot be
/// decoded without a custom `init(from:)`, and there isn't one - only
/// `encode(to:)` below. Nothing reads these events back; they are written out
/// and gone. Claiming Codable asked the compiler to synthesise a decoder it had
/// no way to build.
struct AnalyticsEvent: Encodable {
    let id: UUID
    let timestamp: Date
    let event: String
    let properties: [String: Any]
    let sessionId: String
    let userId: String
    
    enum CodingKeys: String, CodingKey {
        case id, timestamp, event, sessionId, userId
        case properties
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(timestamp, forKey: .timestamp)
        try container.encode(event, forKey: .event)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(userId, forKey: .userId)
        
        // Encode properties as JSON string
        let jsonData = try JSONSerialization.data(withJSONObject: properties)
        let jsonString = String(data: jsonData, encoding: .utf8)
        try container.encode(jsonString, forKey: .properties)
    }
}
