# Portable Agent Bridge

Управление агентами BrowserOS через YAML конфигурации в стиле portable-claude-setup.

## Установка

Конфигурации агентов хранятся в:`~/.browseros/agents/`

## Создание агента

Создать файл конфигурации:

```bash
mkdir -p ~/.browseros/agents/coder
cat > ~/.browseros/agents/coder/agent.yaml << 'EOF'
apiVersion: browseros.io/v1alpha1
kind: PortableAgent
metadata:
  name: coder
  displayName: "Code Assistant"
  description: "Специализированный агент для работы с кодом"
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4-20250514
    apiKey: ${ANTHROPIC_API_KEY}
  systemPrompt: |
    You are a specialized code assistant. Focus on:
    - Clean, maintainable code
    - Type safety
    - Documentation
  tools:
    categories:
      browser: true
      filesystem: true
      memory: false
  workspace:
    defaultDir: ~/projects
    allowedPaths:
      - ~/projects
      - ~/Documents
  limits:
    maxTurns: 50
    maxDuration: 3600
    maxTokens: 200000
  env:
    - name: PROJECT_ROOT
      value: ~/projects
    - name: EDITOR
      value: vscode
EOF
```

## API Endpoints

### Запуск агента

```bash
curl -X POST http://localhost:3000/agent/start \
  -H "Content-Type: application/json" \
  -d '{"name": "coder"}'
```

### Остановка агента

```bash
curl -X POST http://localhost:3000/agent/stop \
  -H "Content-Type: application/json" \
  -d '{"name": "coder"}'
```

### Перезапуск агента

```bash
curl -X POST http://localhost:3000/agent/restart \
  -H "Content-Type: application/json" \
  -d '{"name": "coder"}'
```

### Статус всех агентов

```bash
curl http://localhost:3000/agent/status
```

### Статус конкретного агента

```bash
curl http://localhost:3000/agent/status/coder
```

### Отправка задачи агенту

```bash
curl -X POST http://localhost:3000/agent/coder/task \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Analyze current page and summarize code",
    "context": {
      "conversationId": "some-conversation-id"
    }
  }'
```

### Чтение логов

```bash
# Последние 50 записей
curl http://localhost:3000/agent/coder/logs?tail=50

# С указанной даты
curl http://localhost:3000/agent/coder/logs?since=2024-01-01T00:00:00Z
```

### Stream логов (SSE)

```bash
curl -N http://localhost:3000/agent/coder/logs/stream
```

### Список всех конфигураций

```bash
curl http://localhost:3000/agent/config
```

### Получение конкретной конфигурации

```bash
curl http://localhost:3000/agent/config/coder
```

### Удаление конфигурации

```bash
curl -X DELETE http://localhost:3000/agent/config/coder
```

## Конфигурация

### Переменные окружения

Поддерживаются следующие форматы:

- Прямое значение: `apiKey: "sk-..."`
- Ссылка на переменную: `apiKey: ${ANTHROPIC_API_KEY}`
- С дефолтным значением: `apiKey: ${API_KEY:sk-default}`

Порядок резолюшения:
1. Переменная окружения процесса
2. Файл `~/.browseros/agents/{name}/env.yaml`
3. Глобальный `.env` файл

### Шаблоны

Для повторного использования system prompt:

```yaml
spec:
  template: shared/coder-base
  # Или:
  # template: ./custom-template
```

Шаблоны хранятся в:
- `~/.browseros/agents/shared/{name}/template.yaml`
- `~/.browseros/agents/{name}/template.yaml`

### Фильтрация инструментов

```yaml
tools:
  categories:
    browser: true
    filesystem: true
    memory: false
  allowList:
    - browser.navigate
    - browser.click
  denyList:
    - filesystem.write
```
