//
//  QueenMasterViewModel.swift
//  TriOS - Queen Master Chat
//
//  Global orchestrator for all chats
//

import Foundation
import SwiftUI

/// QueenMasterViewModel - Global orchestrator with context across all chats
@MainActor
class QueenMasterViewModel: ObservableObject {
    
    @Published var isActive: Bool = false
    @Published var currentPlan: QueenTaskPlan?
    @Published var activeChats: [ChatInfo] = []
    @Published var globalContext: QueenContext = QueenContext(
        activeChats: 0,
        recentActions: [],
        hasRelevantHistory: false
    )
    
    private let intelligenceEngine: QueenIntelligenceEngine
    private let taskDelegator: TaskDelegator
    private let teamManager: TeamQueenManager
    
    init() {
        self.intelligenceEngine = QueenIntelligenceEngine()
        self.taskDelegator = TaskDelegator()
        self.teamManager = TeamQueenManager()
    }
    
    /// Activate Queen mode
    func activate() {
        isActive = true
    }
    
    /// Deactivate Queen mode
    func deactivate() {
        isActive = false
    }
    
    /// Analyze request and create plan
    func analyze(_ request: String) async {
        let plan = await intelligenceEngine.analyzeAndPlan(request, context: globalContext)
        currentPlan = plan
        
        // Auto-delegate tasks
        let delegations = await intelligenceEngine.autoDelegate(plan: plan)
        
        // Update global context
        globalContext.activeChats = delegations.count
        globalContext.recentActions = delegations.map { $0.task.description }
    }
    
    /// Get prediction for next action
    func predictNextAction() async {
        // Use intelligence engine predictions
    }
    
    /// Broadcast message to all chats
    func broadcast(_ message: String) async {
        await teamManager.broadcast(message, in: UUID())
    }
}
