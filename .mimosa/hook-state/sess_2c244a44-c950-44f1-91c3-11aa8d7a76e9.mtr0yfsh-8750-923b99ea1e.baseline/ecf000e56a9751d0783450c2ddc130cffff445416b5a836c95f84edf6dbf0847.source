# 🎯 TRIOS Installation — Master Package Summary

**Полный комплект документации для установки trios на другой компьютер**  
**Created**: 2026-05-28 | **Author**: Dmitrii Vasilev (@gHashTag)

---

## 📦 Что включено в этот пакет

### 📚 Документация (6 файлов)

| Файл | Назначение | Время |
|------|-----------|------|
| `INSTALLATION_INDEX.md` | **Главный индекс** — навигация по всем документам | 5 мин |
| `QUICK_START.md` | Быстрая установка (шпаргалка) | 30-45 мин |
| `TRIOS_MASTER_INSTALLATION_GUIDE.md` | Полная пошаговая инструкция | ~2 часа |
| `INSTALLATION_GUIDE.html` | Интерактивный гид с чекбоксами | ~2 часа |
| `INSTALL_TODO.md` | Чек-лист для установки | ~2 часа |
| `ARCHITECTURE_OVERVIEW.md` | Архитектура системы | 30 мин |
| `TRIOS_INSTALLATION_GUIDE.pdf` | PDF-версия для печати | ~2 часа |

### 📄 Дополнительно
- `docs/INSTALLATION_README.md` — README для папки docs
- Этот файл: `MASTER_PACKAGE_SUMMARY.md` — резюме пакета

---

## 🚀 Как использовать

### Вариант 1: Быстрая установка (30-45 мин)
```bash
# 1. Открой шпаргалку
cat QUICK_START.md | less

# 2. Скопируй скрипт установки
# 3. Запусти на целевом компьютере
# 4. Проверь результат
```

### Вариант 2: Полная установка (~2 часа) ⭐ РЕКОМЕНДУЕТСЯ
```bash
# 1. Открой интерактивный гид в браузере
open INSTALLATION_GUIDE.html

# 2. Следуй каждой фазе, отмечай чекбоксы
# 3. Пройди все 8 фаз
# 4. Проверь критерии успеха
```

### Вариант 3: Глубокое понимание (~3 часа)
```bash
# 1. Изучи архитектуру
cat ARCHITECTURE_OVERVIEW.md | less

# 2. Прочитай полную инструкцию
cat TRIOS_MASTER_INSTALLATION_GUIDE.md | less

# 3. Установи, понимая каждый шаг
```

---

## 📋 8 Фаз Установки

Все руководства следуют одной структуре:

| Фаза | Название | Время | Ключевые задачи |
|------|----------|------|----------------|
| 1 | Prerequisites | 30 мин | Xcode, Homebrew, клонирование |
| 2 | Build Trios | 15 мин | Переменные среды, build.sh |
| 3 | Install App | 5 мин | Копирование в Applications, права |
| 4 | Backend Services | 20 мин | Node.js, Rust, PM2, запуск |
| 5 | Tailscale (опция) | 10 мин | Аутентификация, funnel |
| 6 | MCP Clients | 10 мин | Подключение BrowserOS, GitButler |
| 7 | Verification | 15 мин | Тесты приложения и сервисов |
| 8 | Post-Installation | 10 мин | Автозапуск, переменные среды |

**Итого**: ~2 часа (с опциональным Tailscale)

---

## ✅ Критерии Успеха

Установка завершена, когда:
- ✅ Trios запускается и показывает иконку в статус-баре
- ✅ Панель открывается по `Cmd+Shift+T`
- ✅ Все 5 вкладок работают (Chat, Git, Terminal, Queen, Settings)
- ✅ PM2 показывает 3 сервиса онлайн
- ✅ Health checks возвращают 200 OK (порты 9005, 9105, 9203)
- ✅ SSE streaming работает (сообщения в чате)
- ✅ Tailscale URL доступен с другого устройства (если включён)
- ✅ GitButler коммиты работают через Trios

---

## 🛠️ Быстрые Команды

### Открыть гиды
```bash
# Интерактивный HTML (в браузере)
open INSTALLATION_GUIDE.html

# Полная инструкция (в терминале)
cat TRIOS_MASTER_INSTALLATION_GUIDE.md | less

# Шпаргалка
cat QUICK_START.md | less

# Архитектура
cat ARCHITECTURE_OVERVIEW.md | less

# Главный индекс
cat INSTALLATION_INDEX.md | less
```

### Проверка после установки
```bash
# Статус сервисов
pm2 status

# Health checks
curl http://127.0.0.1:9005/health
curl http://127.0.0.1:9105/health
curl http://127.0.0.1:9203/health

# Порты
lsof -i :9005
lsof -i :9105
lsof -i :9203

# Tailscale
tailscale status
```

---

## 🌐 Tailscale Настройка

### Для удалённого доступа
```bash
# Установить
brew install tailscale

# Аутентификация
tailscale up

# Включить публичный доступ (funnel)
tailscale funnel 9105

# Получить URL
tailscale status

# Тест с другого устройства
curl https://<hostname>.tail01804b.ts.net/health
```

### Только для tailnet (приватно)
```bash
tailscale serve --https=443 http://127.0.0.1:9105
```

---

## 🏗️ Архитектура (кратко)

```
PRESENTATION LAYER (SwiftUI views)
         ↓
APPLICATION LAYER (ViewModels, State Machines)
         ↓
INFRASTRUCTURE LAYER (Network, Parsing, Storage)
         ↓
CORE LAYER (Data Models, Protocols)
```

### Backend Сервисы (PM2)
- **trios-server** (Rust, порт 9005) — ядро
- **browseros-mcp** (Node.js, порт 9105) — MCP протокол
- **trios-bridge** (Node.js, порт 9203) — A2A мост, GitButler

### Порты
| Сервис | Порт | Протокол |
|--------|------|----------|
| trios-server | 9005 | HTTP |
| browseros-mcp | 9105 | HTTP/SSE |
| trios-bridge | 9203 | HTTP |
| TRIOS_MESH | 9505 | TCP |
| TRIOS_A2A | 9200 | HTTP |

---

## 🚨 Troubleshooting

### Частые проблемы
```bash
# App не запускается
pkill -9 trios && open ~/Applications/trios.app

# Нет иконки в статус-баре
killall trios && open ~/Applications/trios.app

# QueenUILib не найден
export TRINITY_ROOT=~/trinity

# PM2 сервисы не стартуют
pm2 logs && pm2 restart all

# Tailscale не работает
tailscale logout && tailscale up && tailscale funnel 9105
```

### Логи
```bash
# Логи приложения
log show --predicate 'process == "trios"' --last 1h

# PM2 логи
pm2 logs trios-server --lines 50
pm2 logs browseros-mcp --lines 50
pm2 logs trios-bridge --lines 50
```

---

## 📞 Поддержка

### Документация
- Главный индекс: `INSTALLATION_INDEX.md`
- Шпаргалка: `QUICK_START.md`
- Полная инструкция: `TRIOS_MASTER_INSTALLATION_GUIDE.md`
- Архитектура: `ARCHITECTURE_OVERVIEW.md`

### Онлайн ресурсы
- **GitHub Issues**: https://github.com/gHashTag/BrowserOS/issues
- **Discussions**: https://github.com/gHashTag/BrowserOS/discussions
- **Trinity Project**: https://github.com/gHashTag/trinity
- **Документация**: `/Users/playra/BrowserOS/trios/docs/`

### Логи
- **Сборка**: `~/.trinity/logs/build_*.log`
- **PM2**: `pm2 logs`
- **Console.app**: Поиск "trios" или "browseros"

---

## 📊 Оценки Времени

| Путь | Время | Для кого |
|------|------|----------|
| Быстрый | 30-45 мин | Опытные разработчики |
| Стандартный ⭐ | ~2 часа | Большинство пользователей |
| Глубокий | ~3 часа | Контрибьюторы, архитекторы |

---

## 🎓 Путь Изучения

### Неделя 1: Установка
- День 1-2: Установить trios
- День 3: Исследовать UI, тестировать функции
- День 4-5: Настроить backend сервисы
- День 6-7: Настроить Tailscale

### Неделя 2: Понимание
- День 1-2: Прочитать `ARCHITECTURE_OVERVIEW.md`
- День 3-4: Изучить исходный код
- День 5-7: Эксперименты с конфигурацией

### Неделя 3: Контрибьюция
- Обзор открытых issues
- Отправка PR
- Улучшение документации

---

## 📁 Расположение Файлов

```
/Users/playra/BrowserOS/trios/
├── MASTER_PACKAGE_SUMMARY.md (этот файл)
├── INSTALLATION_INDEX.md ⭐ Начни здесь
├── QUICK_START.md
├── TRIOS_MASTER_INSTALLATION_GUIDE.md
├── INSTALLATION_GUIDE.html
├── INSTALL_TODO.md
├── ARCHITECTURE_OVERVIEW.md
├── TRIOS_INSTALLATION_GUIDE.pdf
├── README.md
├── build.sh
├── main.swift
└── docs/
    └── INSTALLATION_README.md
```

---

## 🎯 Следующие Шаги

**После установки:**

1. **Исследуй приложение**
   - Открой панель: `Cmd+Shift+T`
   - Попробуй каждую вкладку
   - Отправь сообщение в чате

2. **Настрой workflow**
   - Добавь в автозагрузку
   - Настрой PM2 auto-start
   - Добавь переменные среды

3. **Подключи сервисы**
   - BrowserOS MCP
   - GitButler
   - Tailscale (опция)

4. **Изучи архитектуру**
   - Прочитай `ARCHITECTURE_OVERVIEW.md`
   - Изучи исходный код
   - Пойми поток данных

5. **Контрибьють** (опция)
   - Репорть issues
   - Предлагай фичи
   - Отправляй PRs

---

## 📝 Чек-лист для Новых Компьютеров

Распечатай для каждой новой машины:

**Перед началом:**
- [ ] macOS 14.0+ установлен
- [ ] Xcode 15.0+ установлен
- [ ] GitHub аккаунт доступен
- [ ] Tailscale аккаунт (опция)

**После установки:**
- [ ] Все 8 фаз завершены
- [ ] Все критерии успеха выполнены
- [ ] PM2 настроен на автозапуск
- [ ] Trios в login items
- [ ] Tailscale настроен (если нужно)
- [ ] Бэкап создан

---

**Master Package v1.0.0** | 2026-05-28 | Trinity Project (@gHashTag)

**🚀 Начни здесь**: `INSTALLATION_INDEX.md`

**📖 Открыть гид**: `open INSTALLATION_GUIDE.html`

**⚡ Быстрый старт**: `cat QUICK_START.md | less`
