//
//  i18nManager.swift
//  TriOS Hotkey System — Internationalization Manager
//
//  Supports: en, ru, es, zh, fr
//  Add your language: see CONTRIBUTING.md
//

import Foundation

// MARK: - Language Enum

public enum TriOSLanguage: String, CaseIterable {
    case english = "en"
    case russian = "ru"
    case spanish = "es"
    case chinese = "zh"
    case french = "fr"
    
    public var displayName: String {
        switch self {
        case .english: return "English"
        case .russian: return "Русский"
        case .spanish: return "Español"
        case .chinese: return "中文"
        case .french: return "Français"
        }
    }
    
    public var flag: String {
        switch self {
        case .english: return "🇬🇧"
        case .russian: return "🇷🇺"
        case .spanish: return "🇪🇸"
        case .chinese: return "🇨🇳"
        case .french: return "🇫🇷"
        }
    }
}

// MARK: - Localization Strings

public struct TriOSLocalization {
    // Hotkey Bar
    public let hotkeyHelp: String
    public let hotkeySearch: String
    public let hotkeyMacro: String
    public let hotkeySettings: String
    public let hotkeyAccessibility: String
    public let hotkeyAnalytics: String
    
    // Search Overlay
    public let searchPlaceholder: String
    public let searchNoResults: String
    public let searchRecent: String
    
    // Macro Recorder
    public let macroRecord: String
    public let macroStop: String
    public let macroPlay: String
    public let macroSave: String
    public let macroLibrary: String
    
    // Voice Commands
    public let voiceListening: String
    public let voiceProcessing: String
    public let voiceError: String
    
    // Accessibility
    public let a11yHighContrast: String
    public let a11yLargeText: String
    public let a11ySwitchControl: String
    public let a11yVoiceOver: String
    
    // General
    public let buttonOK: String
    public let buttonCancel: String
    public let buttonSave: String
    public let buttonDelete: String
    public let settingsTitle: String
    
    init(language: TriOSLanguage) {
        switch language {
        case .english:
            self = TriOSLocalization(
                hotkeyHelp: "Help",
                hotkeySearch: "Search",
                hotkeyMacro: "Macro",
                hotkeySettings: "Settings",
                hotkeyAccessibility: "Accessibility",
                hotkeyAnalytics: "Analytics",
                searchPlaceholder: "Search messages...",
                searchNoResults: "No results found",
                searchRecent: "Recent",
                macroRecord: "Record",
                macroStop: "Stop",
                macroPlay: "Play",
                macroSave: "Save Macro",
                macroLibrary: "Macro Library",
                voiceListening: "Listening...",
                voiceProcessing: "Processing...",
                voiceError: "Voice command failed",
                a11yHighContrast: "High Contrast",
                a11yLargeText: "Large Text",
                a11ySwitchControl: "Switch Control",
                a11yVoiceOver: "VoiceOver",
                buttonOK: "OK",
                buttonCancel: "Cancel",
                buttonSave: "Save",
                buttonDelete: "Delete",
                settingsTitle: "Settings"
            )
            
        case .russian:
            self = TriOSLocalization(
                hotkeyHelp: "Помощь",
                hotkeySearch: "Поиск",
                hotkeyMacro: "Макрос",
                hotkeySettings: "Настройки",
                hotkeyAccessibility: "Доступность",
                hotkeyAnalytics: "Аналитика",
                searchPlaceholder: "Поиск сообщений...",
                searchNoResults: "Ничего не найдено",
                searchRecent: "Недавние",
                macroRecord: "Записать",
                macroStop: "Стоп",
                macroPlay: "Воспроизвести",
                macroSave: "Сохранить макрос",
                macroLibrary: "Библиотека макросов",
                voiceListening: "Слушаю...",
                voiceProcessing: "Обрабатываю...",
                voiceError: "Ошибка голосовой команды",
                a11yHighContrast: "Высокий контраст",
                a11yLargeText: "Крупный текст",
                a11ySwitchControl: "Switch Control",
                a11yVoiceOver: "VoiceOver",
                buttonOK: "OK",
                buttonCancel: "Отмена",
                buttonSave: "Сохранить",
                buttonDelete: "Удалить",
                settingsTitle: "Настройки"
            )
            
        case .spanish:
            self = TriOSLocalization(
                hotkeyHelp: "Ayuda",
                hotkeySearch: "Buscar",
                hotkeyMacro: "Macro",
                hotkeySettings: "Configuración",
                hotkeyAccessibility: "Accesibilidad",
                hotkeyAnalytics: "Analíticas",
                searchPlaceholder: "Buscar mensajes...",
                searchNoResults: "No se encontraron resultados",
                searchRecent: "Recientes",
                macroRecord: "Grabar",
                macroStop: "Detener",
                macroPlay: "Reproducir",
                macroSave: "Guardar Macro",
                macroLibrary: "Biblioteca de Macros",
                voiceListening: "Escuchando...",
                voiceProcessing: "Procesando...",
                voiceError: "Error de comando de voz",
                a11yHighContrast: "Alto Contraste",
                a11yLargeText: "Texto Grande",
                a11ySwitchControl: "Switch Control",
                a11yVoiceOver: "VoiceOver",
                buttonOK: "OK",
                buttonCancel: "Cancelar",
                buttonSave: "Guardar",
                buttonDelete: "Eliminar",
                settingsTitle: "Configuración"
            )
            
        case .chinese:
            self = TriOSLocalization(
                hotkeyHelp: "帮助",
                hotkeySearch: "搜索",
                hotkeyMacro: "宏",
                hotkeySettings: "设置",
                hotkeyAccessibility: "辅助功能",
                hotkeyAnalytics: "分析",
                searchPlaceholder: "搜索消息...",
                searchNoResults: "未找到结果",
                searchRecent: "最近",
                macroRecord: "录制",
                macroStop: "停止",
                macroPlay: "播放",
                macroSave: "保存宏",
                macroLibrary: "宏库",
                voiceListening: "正在聆听...",
                voiceProcessing: "正在处理...",
                voiceError: "语音命令失败",
                a11yHighContrast: "高对比度",
                a11yLargeText: "大字体",
                a11ySwitchControl: "切换控制",
                a11yVoiceOver: "VoiceOver",
                buttonOK: "确定",
                buttonCancel: "取消",
                buttonSave: "保存",
                buttonDelete: "删除",
                settingsTitle: "设置"
            )
            
        case .french:
            self = TriOSLocalization(
                hotkeyHelp: "Aide",
                hotkeySearch: "Rechercher",
                hotkeyMacro: "Macro",
                hotkeySettings: "Paramètres",
                hotkeyAccessibility: "Accessibilité",
                hotkeyAnalytics: "Analytiques",
                searchPlaceholder: "Rechercher des messages...",
                searchNoResults: "Aucun résultat trouvé",
                searchRecent: "Récent",
                macroRecord: "Enregistrer",
                macroStop: "Arrêter",
                macroPlay: "Lire",
                macroSave: "Enregistrer la Macro",
                macroLibrary: "Bibliothèque de Macros",
                voiceListening: "Écoute...",
                voiceProcessing: "Traitement...",
                voiceError: "Échec de la commande vocale",
                a11yHighContrast: "Contraste Élevé",
                a11yLargeText: "Texte Grand",
                a11ySwitchControl: "Contrôle par Interrupteur",
                a11yVoiceOver: "VoiceOver",
                buttonOK: "OK",
                buttonCancel: "Annuler",
                buttonSave: "Enregistrer",
                buttonDelete: "Supprimer",
                settingsTitle: "Paramètres"
            )
        }
    }
}

// MARK: - i18n Manager

public final class TriOSi18nManager {
    public static let shared = TriOSi18nManager()
    
    private let userDefaultsKey = "TriOSPreferredLanguage"
    
    public var currentLanguage: TriOSLanguage {
        get {
            if let code = UserDefaults.standard.string(forKey: userDefaultsKey),
               let language = TriOSLanguage(rawValue: code) {
                return language
            }
            // Auto-detect from system
            let systemLang = Locale.current.language.languageCode?.identifier
            return TriOSLanguage(rawValue: systemLang ?? "en") ?? .english
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: userDefaultsKey)
            NotificationCenter.default.post(name: .triosLanguageDidChange, object: nil)
        }
    }
    
    public var localization: TriOSLocalization {
        TriOSLocalization(language: currentLanguage)
    }
    
    public var supportedLanguages: [TriOSLanguage] {
        TriOSLanguage.allCases
    }
    
    private init() {}
}

// MARK: - Notification

public extension Notification.Name {
    static let triosLanguageDidChange = Notification.Name("triosLanguageDidChange")
}

// MARK: - Usage Example

/*
 // Get current localization
 let l10n = TriOSi18nManager.shared.localization
 print(l10n.hotkeyHelp) // "Help" or "Помощь" etc.
 
 // Change language
 TriOSi18nManager.shared.currentLanguage = .russian
 
 // Observe language changes
 NotificationCenter.default.addObserver(
     self,
     selector: #selector(languageDidChange),
     name: .triosLanguageDidChange,
     object: nil
 )
 
 // Add your language:
 // 1. Add case to TriOSLanguage enum
 // 2. Add localization in TriOSLocalization init
 // 3. Submit PR (see CONTRIBUTING.md)
 */

// MARK: - Adding Your Language

/*
 To add a new language (e.g., German):
 
 1. Add to enum:
    case german = "de"
 
 2. Add flag:
    case .german: return "🇩🇪"
 
 3. Add displayName:
    case .german: return "Deutsch"
 
 4. Add localization in init:
    case .german:
        self = TriOSLocalization(
            hotkeyHelp: "Hilfe",
            hotkeySearch: "Suchen",
            // ... all other strings
        )
 
 5. Test:
    TriOSi18nManager.shared.currentLanguage = .german
    print(TriOSi18nManager.shared.localization.hotkeyHelp) // "Hilfe"
 
 6. Submit PR with your changes!
 */
