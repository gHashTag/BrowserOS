# Quick Start — Agent Social Network

## 🚀 Запуск за 5 минут

### 1. Применить миграции БД

```bash
cd /Users/playra/BrowserOS/packages/browseros-agent

# Chat schema (title + metadata)
bun run scripts/migrate-chat-schema.ts

# Task Queue schema
psql $DATABASE_URL -f scripts/migrate-task-queue.sql
# или
psql $RAILWAY_SSOT_URL -f scripts/migrate-task-queue.sql
```

### 2. Перезапустить сервер

```bash
# Остановить текущий (если запущен)
pkill -f "bun.*apps/server"

# Запустить сервер
cd /Users/playra/BrowserOS/packages/browseros-agent/apps/server
bun run src/index.ts
```

Или через Trios UI — кнопка "Start Server" в ServerManager.

### 3. Проверить API

```bash
# Health check
curl http://localhost:9105/health

# Создать чат
curl -X POST http://localhost:9105/api/chats \
  -H "Content-Type: application/json" \
  -d '{"profileId": "test-user", "title": "My First Chat"}'

# Создать задачу
curl -X POST http://localhost:9105/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "scout-001",
    "taskType": "research",
    "payload": {"type": "search", "data": {"query": "Trinity"}}
  }'
```

---

## 📡 API Endpoints

### Chat API
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chats` | Создать чат |
| POST | `/api/chats/:id/messages` | Добавить сообщение |
| GET | `/api/chats` | Список чатов |
| GET | `/api/chats/:id` | Транскрипт чата |
| GET | `/api/chats/search` | Поиск по чатам |
| DELETE | `/api/chats/:id` | Удалить чат |

### Task Queue API
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/tasks` | Создать задачу |
| GET | `/api/tasks` | Список задач |
| GET | `/api/tasks/queue/:agentId` | Dequeue задача |
| GET | `/api/tasks/stats` | Статистика |
| PUT | `/api/tasks/:id` | Обновить статус |
| POST | `/api/tasks/:id/retry` | Повторить |
| POST | `/api/tasks/:id/cancel` | Отменить |
| DELETE | `/api/tasks/:id` | Удалить |

### A2A API
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/a2a/register` | Регистрация агента |
| POST | `/api/a2a/heartbeat` | Heartbeat |
| POST | `/api/a2a/message` | Сообщение агенту |
| GET | `/api/a2a/stream` | SSE streaming |
| GET | `/api/a2a/agents` | Список агентов |
| GET | `/api/a2a/matrix` | Agent Matrix |

---

## 🎯 Use Cases

### Use Case 1: Doctor создаёт задачу для Scout

```bash
# 1. Doctor создаёт чат для координации
CHAT=$(curl -X POST http://localhost:9105/api/chats \
  -H "Content-Type: application/json" \
  -d '{"profileId": "doctor-001", "title": "Scout Mission #42"}')

# 2. Doctor назначает задачу Scout
TASK=$(curl -X POST http://localhost:9105/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "scout-001",
    "taskType": "research",
    "payload": {
      "type": "web-search",
      "data": {"query": "Trinity architecture patterns"}
    },
    "priority": 10,
    "metadata": {"chatId": "conv-..."}
  }')

# 3. Scout polling задачи
curl http://localhost:9105/api/tasks/queue/scout-001

# 4. Scout выполняет и обновляет статус
curl -X PUT http://localhost:9105/api/tasks/task-123 \
  -H "Content-Type: application/json" \
  -d '{"status": "completed", "result": {"findings": [...]}}'
```

### Use Case 2: Agent-to-Agent messaging

```bash
# Doctor отправляет сообщение Scout
curl -X POST http://localhost:9105/api/a2a/message \
  -H "Content-Type: application/json" \
  -d '{
    "id": "msg-001",
    "sender": "doctor-001",
    "recipient": "scout-001",
    "type": "coordination",
    "payload": {"action": "start-research", "topic": "Trinity"}
  }'

# Scout слушает SSE stream
curl -N "http://localhost:9105/api/a2a/stream?agentId=scout-001"
```

---

## 🛠️ Development

### Добавить нового агента

1. Создать SOUL.md в `/trios/.trios/agents/:name/SOUL.md`
2. Обновить `/trios/.trios/agents/registry.json`
3. Зарегистрировать через API:
   ```bash
   curl -X POST http://localhost:9105/api/a2a/register \
     -d '{"id": "new-agent-001", "name": "New Agent", ...}'
   ```

### Добавить новую задачу

1. Определить тип задачи в payload
2. Реализовать обработчик в агенте
3. Создать через POST /api/tasks

---

## 📊 Monitoring

```bash
# Статистика очереди
curl http://localhost:9105/api/tasks/stats

# Список агентов
curl http://localhost:9105/api/a2a/agents

# Agent Matrix
curl http://localhost:9105/api/a2a/matrix
```

---

## ❓ Troubleshooting

**Server не запускается:**
```bash
# Проверить логи
tail -f /Users/playra/trinity/logs/browseros-companion.log

# Проверить порт
lsof -i :9105
```

**БД не подключается:**
```bash
# Проверить DATABASE_URL
echo $DATABASE_URL
echo $RAILWAY_SSOT_URL

# Проверить соединение
psql $DATABASE_URL -c "SELECT 1"
```

**Задачи не выполняются:**
```bash
# Проверить очередь
curl http://localhost:9105/api/tasks?agentId=scout-001

# Проверить статус агента
curl http://localhost:9105/api/a2a/agents
```

---

**Docs:** `/Users/playra/BrowserOS/AGENT_SOCIAL_NETWORK_API.md`  
**Architecture:** `/Users/playra/BrowserOS/AGENT_SOCIAL_NETWORK.md`
