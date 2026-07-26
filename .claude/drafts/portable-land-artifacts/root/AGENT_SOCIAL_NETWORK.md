# Agent Social Network — Архитектура

## 🎯 Цель
Социальная сеть для агентов где агенты могут:
- Создавать чаты/сессии
- Читать историю других чатов (с разрешениями)
- Назначать задачи друг другу
- Координироваться через task queue
- Спавнить новых агентов динамически

## 📊 Текущее состояние (Audit 2026-01-15)

### ✅ Что уже есть:
- A2A API: `/api/a2a/*` (register, heartbeat, message, task/assign, stream)
- GraphQL schema: `conversations`, `conversationMessages` в PostgreSQL
- Agent registry: `/trios/.trios/agents/registry.json` (4 агента)
- SessionStore: in-memory Map (нужна персистентность)

### ❌ Чего нет:
1. **HTTP endpoint для создания чатов** — только GraphQL internal
2. **HTTP endpoint для чтения истории чатов** — нет public API
3. **Персистентность сессий** — теряются при рестарте
4. **Agent factory** — нельзя спавнить новых агентов
5. **Task queue с приоритетами** — нет очереди, retry logic
6. **ACL/permissions** — нет контроля доступа к чатам

## 🏗️ Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Social Network                      │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │   Doctor     │  │    Guard     │  │    Scout     │       │
│  │  (orchestr)  │  │  (quality)   │  │  (research)  │       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
│         │                 │                 │                 │
│         └────────────┬────┴────┬────────────┘                 │
│                      │         │                              │
│              ┌───────▼─────────▼───────┐                      │
│              │    A2A Message Bus      │                      │
│              │  /api/a2a/message       │                      │
│              │  /api/a2a/stream (SSE)  │                      │
│              └───────────┬─────────────┘                      │
│                          │                                    │
│              ┌───────────▼─────────────┐                      │
│              │     Task Queue (PG)     │                      │
│              │  - priorities           │                      │
│              │  - retry logic          │                      │
│              │  - status tracking      │                      │
│              └───────────┬─────────────┘                      │
│                          │                                    │
│         ┌────────────────┼────────────────┐                   │
│         │                │                │                   │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐          │
│  │  Chat API   │  │ Agent API   │  │  Memory API │          │
│  │  /api/chats │  │ /api/agents │  │ /api/memory │          │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘          │
│         │                │                │                   │
│         └────────────────┼────────────────┘                   │
│                          │                                    │
│              ┌───────────▼─────────────┐                      │
│              │   PostgreSQL (Neon)     │                      │
│              │  - conversations        │                      │
│              │  - conversation_messages│                      │
│              │  - agents               │                      │
│              │  - agent_tasks          │                      │
│              │  - agent_permissions    │                      │
│              └─────────────────────────┘                      │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## 📋 API Endpoints (новые)

### Chat API
```
POST   /api/chats              → создать новый чат
GET    /api/chats              → список чатов пользователя
GET    /api/chats/:id          → транскрипт чата
GET    /api/chats/search?q=    → поиск по чатам
DELETE /api/chats/:id          → удалить чат
```

### Agent API
```
POST   /api/agents/spawn       → создать нового агента
POST   /api/agents/terminate   → завершить агента
GET    /api/agents             → список агентов
GET    /api/agents/:id/status  → статус агента
POST   /api/agents/:id/task    → назначить задачу агенту
```

### Task Queue API
```
GET    /api/tasks              → список задач (фильтры: status, priority, agent)
POST   /api/tasks              → создать задачу
PUT    /api/tasks/:id          → обновить статус задачи
DELETE /api/tasks/:id          → удалить задачу
```

## 🗄️ Database Schema (дополнения)

```sql
-- Agent tasks queue
CREATE TABLE agent_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  priority INT DEFAULT 0,
  status TEXT DEFAULT 'pending', -- pending, running, completed, failed
  retry_count INT DEFAULT 0,
  max_retries INT DEFAULT 3,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  result JSONB
);

-- Agent permissions (ACL)
CREATE TABLE agent_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  resource_type TEXT NOT NULL, -- 'conversation', 'task', 'memory'
  resource_id TEXT NOT NULL,
  permission TEXT NOT NULL, -- 'read', 'write', 'admin'
  granted_by TEXT NOT NULL,
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  UNIQUE(agent_id, resource_type, resource_id, permission)
);

-- Agent instances (dynamic spawning)
CREATE TABLE agent_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_template_id TEXT NOT NULL,
  instance_name TEXT NOT NULL,
  status TEXT DEFAULT 'idle', -- idle, busy, offline
  capabilities JSONB,
  current_task_id UUID REFERENCES agent_tasks(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_heartbeat TIMESTAMPTZ,
  metadata JSONB
);
```

## 🎯 Phase 1: Доступ к чатам (сейчас)
1. Добавить `/api/chats` endpoints
2. Интеграция с существующим GraphQL
3. Персистентность сессий в PostgreSQL

## 🎯 Phase 2: Мульти-агентность
1. Agent factory для спавна
2. Task queue с приоритетами
3. SSE streaming для уведомлений

## 🎯 Phase 3: Социальная сеть
1. Agent profiles + capabilities
2. Agent-to-agent messaging
3. Task marketplace (агенты берут задачи сами)
4. Reputation system

---
**Status:** In Progress
**Started:** 2026-01-15
**Owner:** 🔬 Doctor (BrowserOS-Agent)
