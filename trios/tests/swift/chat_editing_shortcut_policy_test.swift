import Foundation

@main
struct ChatEditingShortcutPolicyTest {
    static func main() {
        let commandOnly = ChatEditingModifierState(
            command: true,
            shift: false,
            option: false,
            control: false
        )

        expect(resolve(8, commandOnly) == .copy, "Command-C")
        expect(resolve(9, commandOnly) == .paste, "Command-V")
        expect(resolve(7, commandOnly) == .cut, "Command-X")
        expect(resolve(0, commandOnly) == .selectAll, "Command-A")
        expect(resolve(6, commandOnly) == .undo, "Command-Z")

        let commandShift = ChatEditingModifierState(
            command: true,
            shift: true,
            option: false,
            control: false
        )
        expect(resolve(6, commandShift) == .redo, "Command-Shift-Z")

        let noCommand = ChatEditingModifierState(
            command: false,
            shift: false,
            option: false,
            control: false
        )
        expect(resolve(9, noCommand) == nil, "plain V is not paste")

        let commandOption = ChatEditingModifierState(
            command: true,
            shift: false,
            option: true,
            control: false
        )
        expect(resolve(9, commandOption) == nil, "Command-Option-V remains available")

        expect(resolve(40, commandOnly) == nil, "Command-K remains a composer shortcut")
        expect(resolve(37, commandOnly) == nil, "Command-L remains a composer shortcut")

        print("All ChatEditingShortcutPolicy tests passed.")
    }

    private static func resolve(
        _ keyCode: UInt16,
        _ modifiers: ChatEditingModifierState
    ) -> ChatEditingCommand? {
        ChatEditingShortcutPolicy.command(forKeyCode: keyCode, modifiers: modifiers)
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
