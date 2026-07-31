import Cocoa
import Foundation

// MARK: - Screen Management

class TriosScreenManager {
    static let shared = TriosScreenManager()

    var currentScreen: NSScreen?
    var panelMode: TriosPanelMode = .glassmorphismSidebar

    func detectScreenForMouse() -> NSScreen? {
        let mouseLocation = NSEvent.mouseLocation
        return NSScreen.screens.first { screen in
            screen.frame.contains(mouseLocation)
        } ?? NSScreen.main
    }

    func positionPanel(_ panel: NSWindow, on screen: NSScreen? = nil, width: CGFloat = 400) {
        let targetScreen = screen ?? detectScreenForMouse() ?? NSScreen.main ?? NSScreen.screens.first ?? NSScreen()
        guard targetScreen.frame.width > 0 else { return }
        let frame = targetScreen.visibleFrame

        let panelHeight = frame.height
        let x = frame.maxX - width
        let y = frame.minY

        panel.setFrame(NSRect(x: x, y: y, width: width, height: panelHeight), display: true, animate: false)
        currentScreen = targetScreen
    }

    func applyMode(to panel: NSWindow) {
        panel.styleMask = panelMode.styleMask
        panel.collectionBehavior = panelMode.collectionBehavior
        panel.level = panelMode.level
        panel.isOpaque = panelMode.isOpaque
        if let color = panelMode.backgroundColor {
            panel.backgroundColor = color
        } else {
            panel.backgroundColor = nil
        }
    }

    func setCleanCaptureMode(_ enabled: Bool, for panel: NSWindow) {
        if enabled {
            panel.appearance = nil
            panel.backgroundColor = .black
            panel.isOpaque = true
        } else {
            panel.appearance = NSAppearance(named: .darkAqua)
            applyMode(to: panel)
        }
    }

    func cycleToNextMode() {
        let all = TriosPanelMode.allCases
        guard let currentIndex = all.firstIndex(of: panelMode) else { return }
        let nextIndex = (currentIndex + 1) % all.count
        panelMode = all[nextIndex]
    }
}

// MARK: - Screen Extension

extension NSScreen {
    var displayName: String? {
        guard let screenNumber = deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else {
            return nil
        }
        return "Display \(screenNumber)"
    }
}
