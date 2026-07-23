import Foundation

enum ChatEditingCommand: Equatable {
    case copy
    case paste
    case cut
    case selectAll
    case undo
    case redo
}

struct ChatEditingModifierState: Equatable {
    let command: Bool
    let shift: Bool
    let option: Bool
    let control: Bool
}

enum ChatEditingShortcutPolicy {
    static func command(
        forKeyCode keyCode: UInt16,
        modifiers: ChatEditingModifierState
    ) -> ChatEditingCommand? {
        guard modifiers.command, !modifiers.option, !modifiers.control else {
            return nil
        }

        switch keyCode {
        case 8 where !modifiers.shift:
            return .copy
        case 9 where !modifiers.shift:
            return .paste
        case 7 where !modifiers.shift:
            return .cut
        case 0 where !modifiers.shift:
            return .selectAll
        case 6:
            return modifiers.shift ? .redo : .undo
        default:
            return nil
        }
    }
}
