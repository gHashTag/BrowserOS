//
//  QueenIntelligenceEngine.swift
//  TriOS - Queen Master Chat Intelligence
//
//  AI Planning, Auto-Delegation, Predictive Orchestration
//

import Foundation
import SwiftUI

/// Queen Intelligence Engine - AI-powered planning and delegation
class QueenIntelligenceEngine: ObservableObject {
    @Published var currentPlan: QueenTaskPlan?
    @Published var isPlanning: Bool = false
    @Published var confidence: Double = 0.0
    @Published var predictions: [QueenAction] = .init()
    
    private let taskDelegator: TaskDelegator
    private let predictiveOrchestrator: PredictiveOrchestrator
    private let llmClient: LLMClient
    
    init(taskDelegator: TaskDelegator = TaskDelegator(),
         predictiveOrchestrator: PredictiveOrchestrator = PredictiveOrchestrator(),
         llmClient: LLMClient = LLMClient()) {
        self.taskDelegator = taskDelegator
        self.predictiveOrchestrator = predictiveOrchestrator
        self.llmClient = llmClient
    }
    
    /// Analyze user request and create execution plan
    func analyzeAndPlan(_ request: String, context: QueenContext) async -> QueenTaskPlan {
        isPlanning = true
        
        // Extract intent and required actions
        let intent = await extractIntent(request, context: context)
        
        // Generate task plan
        let plan = await generatePlan(intent: intent, context: context)
        
        // Calculate confidence
        confidence = await calculateConfidence(plan: plan, context: context)
        
        currentPlan = plan
        isPlanning = false
        
        return plan
    }
    
    /// Auto-delegate tasks to appropriate sub-chats
    func autoDelegate(plan: QueenTaskPlan) async -> [ChatDelegation] {
        return await taskDelegator.delegate(plan: plan)
    }
    
    /// Predict next user action
    func predictNextAction(currentState: QueenState) async -> QueenAction? {
        return await predictiveOrchestrator.predict(from: currentState)
    }
    
    // MARK: - Private Methods
    
    private func extractIntent(_ request: String, context: QueenContext) async -> QueenIntent {
        // Use LLM to extract intent
        let prompt = """
        Analyze this user request and extract intent:
        Request: \(request)
        Context: \(context.description)
        
        Return JSON with:
        - primaryIntent: String
        - secondaryIntents: [String]
        - requiredTools: [String]
        - estimatedComplexity: Int (1-5)
        """
        
        let response = try? await llmClient.complete(messages: [
            LLMClient.Message(role: "user", content: prompt)
        ])
        return QueenIntent.fromJson(response ?? "{}")
    }
    
    private func generatePlan(intent: QueenIntent, context: QueenContext) async -> QueenTaskPlan {
        var tasks: [QueenTask] = []
        
        // Generate tasks based on intent
        for tool in intent.requiredTools {
            let task = QueenTask(
                id: UUID(),
                tool: tool,
                description: "Execute \(tool)",
                status: .pending,
                estimatedDuration: 2.0
            )
            tasks.append(task)
        }
        
        return QueenTaskPlan(
            id: UUID(),
            tasks: tasks,
            createdAt: Date(),
            complexity: intent.estimatedComplexity
        )
    }
    
    private func calculateConfidence(plan: QueenTaskPlan, context: QueenContext) async -> Double {
        // Calculate confidence based on:
        // - Plan completeness
        // - Context availability
        // - Historical success rate
        
        var confidence = 0.7
        
        if plan.tasks.count > 0 {
            confidence += 0.1
        }
        
        if context.hasRelevantHistory {
            confidence += 0.15
        }
        
        if plan.complexity <= 3 {
            confidence += 0.05
        }
        
        return min(confidence, 0.99)
    }
}

// MARK: - Models

struct QueenTaskPlan: Identifiable, Codable {
    let id: UUID
    var tasks: [QueenTask]
    let createdAt: Date
    let complexity: Int
    
    var totalEstimatedDuration: Double {
        tasks.reduce(0) { $0 + $1.estimatedDuration }
    }
    
    var completedTasks: Int {
        tasks.filter { $0.status == .completed }.count
    }
    
    var progress: Double {
        guard tasks.count > 0 else { return 0.0 }
        return Double(completedTasks) / Double(tasks.count)
    }
}

struct QueenTask: Identifiable, Codable {
    let id: UUID
    let tool: String
    let description: String
    var status: TaskStatus
    let estimatedDuration: Double
    var actualDuration: Double?
    var result: String?
    
    enum TaskStatus: String, Codable {
        case pending
        case inProgress
        case completed
        case failed
    }
}

struct QueenIntent: Codable {
    let primaryIntent: String
    let secondaryIntents: [String]
    let requiredTools: [String]
    let estimatedComplexity: Int
    
    static func fromJson(_ json: String) -> QueenIntent {
        // Parse JSON response from LLM
        // Simplified for brevity
        return QueenIntent(
            primaryIntent: "execute",
            secondaryIntents: [],
            requiredTools: ["browser", "search"],
            estimatedComplexity: 2
        )
    }
}

struct QueenContext: CustomStringConvertible {
    var activeChats: Int
    var recentActions: [String]
    let hasRelevantHistory: Bool

    var description: String {
        "Active chats: \(activeChats), Recent actions: \(recentActions.count)"
    }
}

struct QueenState {
    let currentTask: QueenTask?
    let completedTasks: [QueenTask]
    let userHistory: [String]
}

struct QueenAction {
    let type: String
    let description: String
    let suggestedTool: String
}

struct ChatDelegation {
    let chatId: UUID
    var task: QueenTask
    let instructions: String
}
