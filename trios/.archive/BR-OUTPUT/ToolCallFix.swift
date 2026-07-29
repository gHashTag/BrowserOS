//
//  ToolCallFix.swift
//  TriOS - Fix for missing tool call cards in chat
//
//  Problem: toolCalls not being added to message during streaming
//  Solution: Ensure toolCalls are added to original message, not copy
//

import Foundation
import SwiftUI

class ToolCallFix {
    static let shared = ToolCallFix()
    
    // Ensure tool calls are added to message BEFORE rendering
    func addToolCallToMessage(_ message: BrowserOSChatMessage, toolCall: ToolCall) {
        DispatchQueue.main.async {
            message.toolCalls.append(toolCall)
            // Force UI update
            message.objectWillChange.send()
        }
    }
    
    // Verify tool calls are visible in UI
    func verifyToolCallsVisible(_ message: BrowserOSChatMessage) -> Bool {
        return !message.toolCalls.isEmpty && message.hasToolCalls
    }
    
    // Debug: Log tool call state
    func logToolCallState(_ message: BrowserOSChatMessage, file: String = #file, line: Int = #line) {
        print("[ToolCallDebug] \(file):\(line) - toolCalls: \(message.toolCalls.count), hasToolCalls: \(message.hasToolCalls)")
    }
}
