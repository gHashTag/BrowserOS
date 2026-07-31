import Cocoa
import Foundation

// MARK: - Panel Mode Enum

enum TriosPanelMode: String, CaseIterable {
    case glassmorphismSidebar = "Glassmorphism Sidebar"
    case floatingSidebar = "Floating Sidebar"
    case hudMinimal = "HUD Minimal"
    case borderlessOverlay = "Borderless Overlay"
    case stationaryWidget = "Stationary Widget"

    var styleMask: NSWindow.StyleMask {
        switch self {
        case .glassmorphismSidebar:
            return [.fullSizeContentView]
        case .floatingSidebar:
            return [.titled, .closable, .utilityWindow]
        case .hudMinimal:
            return [.hudWindow, .nonactivatingPanel]
        case .borderlessOverlay:
            return [.borderless, .fullSizeContentView]
        case .stationaryWidget:
            return [.titled, .closable, .utilityWindow]
        }
    }

    var collectionBehavior: NSWindow.CollectionBehavior {
        switch self {
        case .glassmorphismSidebar:
            return [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        case .floatingSidebar:
            return [.transient, .canJoinAllSpaces, .fullScreenAuxiliary]
        case .hudMinimal:
            return [.transient, .canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        case .borderlessOverlay:
            return [.transient, .canJoinAllSpaces, .ignoresCycle]
        case .stationaryWidget:
            return [.stationary, .canJoinAllSpaces, .ignoresCycle]
        }
    }

    var level: NSWindow.Level {
        switch self {
        case .glassmorphismSidebar: return .mainMenu
        case .floatingSidebar: return .normal
        case .hudMinimal: return .floating
        case .borderlessOverlay: return .popUpMenu
        case .stationaryWidget: return .normal
        }
    }

    var isFloatingPanel: Bool {
        switch self {
        case .glassmorphismSidebar, .hudMinimal: return true
        default: return false
        }
    }

    var isOpaque: Bool {
        switch self {
        case .borderlessOverlay, .glassmorphismSidebar: return false
        default: return true
        }
    }

    var backgroundColor: NSColor? {
        switch self {
        case .borderlessOverlay, .glassmorphismSidebar: return .clear
        default: return nil
        }
    }
}

// MARK: - KeyWindow

class KeyWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}
