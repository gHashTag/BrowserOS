# Contributing to TriOS Hotkey System 🤝

Thank you for considering contributing! This guide helps you get started.

## 🎯 How to Contribute

### 1. Report Bugs
- Check existing issues first
- Use bug report template
- Include: macOS version, TriOS version, steps to reproduce

### 2. Suggest Features
- Use feature request template
- Explain use case
- Vote on existing requests

### 3. Submit Code
1. Fork the repo
2. Create branch: `feature/your-feature` or `fix/issue-number`
3. Make changes
4. Run tests: `swift test`
5. Submit PR with description

### 4. Improve Documentation
- Fix typos
- Add examples
- Translate to your language (see i18n section)

### 5. Accessibility Audit
- Test with VoiceOver
- Test with Switch Control
- Report issues with `a11y` label

## 🛠 Development Setup

```bash
git clone https://github.com/your-username/BrowserOS.git
cd BrowserOS/trios
./build.sh
open trios.app
```

**Requirements**:
- macOS 13.0+
- Xcode 15.0+
- Swift 5.9+

## 📝 Code Style

### Swift Conventions
- Follow [Swift API Design Guidelines](https://swift.org/documentation/api-design-guidelines/)
- Use `camelCase` for variables/functions
- Use `PascalCase` for types
- 2-space indentation
- Max line length: 120 chars

### Example Plugin
```swift
import TriOSPluginAPI

@TriOSPlugin
public class MyPlugin: TriOSPluginProtocol {
    public static var name: String = "My Plugin"
    public static var version: String = "1.0.0"
    
    public init() {}
    
    public func execute(action: String, params: [String: Any]) async throws -> Any {
        switch action {
        case "greet":
            return "Hello, \(params["name"] ?? "World")!"
        default:
            throw TriOSPluginError.unknownAction(action)
        }
    }
}
```

## 🌍 Internationalization (i18n)

Add your language to `i18nManager.swift`:

```swift
case .spanish:
    return [
        "hotkey.help": "Ayuda",
        "hotkey.search": "Buscar",
        // ... more translations
    ]
```

**Supported**: en, ru, es, zh, fr  
**Needed**: de, ja, ko, pt, it, nl, pl, tr

## ♿ Accessibility Guidelines

When contributing:
1. Test with VoiceOver (Cmd+F5)
2. Test with Switch Control
3. Ensure keyboard-only navigation
4. Use semantic HTML/SwiftUI
5. Add accessibility labels
6. Support Dynamic Type

## 🧪 Testing

```bash
# Run all tests
swift test

# Run specific test
swift test --filter HotkeyBarTests

# Run with coverage
swift test --enable-code-coverage
```

## 📬 Pull Request Process

1. **Branch**: `feature/your-feature` or `fix/issue-123`
2. **Title**: Clear and descriptive
3. **Description**: What, why, how
4. **Tests**: Add/update tests
5. **Docs**: Update README if needed
6. **Review**: Address feedback

## 🏷 Issue Labels

- `bug` — something isn't working
- `enhancement` — new feature request
- `a11y` — accessibility issue
- `i18n` — translation/localization
- `plugin` — plugin API
- `documentation` — docs improvement
- `good first issue` — beginner-friendly
- `help wanted` — need community help

## 💬 Community

- **Discussions**: https://github.com/gHashTag/BrowserOS/discussions
- **Discord**: [link TBD]
- **Twitter**: [@TrinityProject](https://twitter.com)

## 📜 Code of Conduct

Be respectful, inclusive, and constructive. Harassment, discrimination, or toxic behavior will not be tolerated.

---

**Thank you for making TriOS better! 🚀**
