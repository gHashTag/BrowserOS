# Implementation Plan — Agent Social Network

## ✅ Phase 0: Audit Complete (2026-01-15)

### Already Implemented:
- ✅ `/api/chats` GET — список чатов
- ✅ `/api/chats/:id` GET — транскрипт чата
- ✅ `/api/chats/search` GET — поиск по чатам
- ✅ `/api/chats/:id` DELETE — удалить чат
- ✅ ChatHistoryService — полный сервис для работы с PostgreSQL
- ✅ A2A API — `/api/a2a/*` (register, heartbeat, message, task/assign, stream)
- ✅ Agent harness — мощная инфраструктура для агентов

### Missing:
- ❌ POST `/api/chats` — создать новый чат
- ❌ POST `/api/agents/spawn` — создать нового агента
- ❌ Task queue с приоритетами и retry
- ❌ Agent permissions (ACL)
- ❌ Session persistence (сохранять сессии в DB)

---

## 🚀 Phase 1: Создание чатов (СЕЙЧАС)

### 1.1 Добавить POST /api/chats
**Файл:** `apps/server/src/api/routes/chat-history.ts`

**Request:**
```json
POST /api/chats
{
  "profileId": "user-123",
  "title": "My new chat",
  "metadata": {}
}
```

**Response:**
```json
{
  "success": true,
  "conversation": {
    "id": "conv-abc123",
    "profileId": "user-123",
    "createdAt": "2026-01-15T14:30:00Z",
    "lastMessagedAt": "2026-01-15T14:30:00Z"
  }
}
```

**SQL:**
```sql
INSERT INTO conversations ("rowId", "profileId", "createdAt", "lastMessagedAt")
VALUES ($1, $2, NOW(), NOW())
```

### 1.2 Добавить POST /api/chats/:id/messages
**Файл:** `apps/server/src/api/routes/chat-history.ts`

**Request:**
```json
POST /api/chats/conv-123/messages
{
  "role": "user",
  "content": "Hello!",
  "metadata": {}
}
```

**Response:**
```json
{
  "success": true,
  "message": {
    "id": "msg-xyz789",
    "conversationId": "conv-123",
    "role": "user",
    "content": "Hello!",
    "timestamp": "2026-01-15T14:31:00Z"
  }
}
```

---

## 🚀 Phase 2: Agent Spawning

### 2.1 Agent Factory
**Файл:** `apps/server/src/api/routes/agents.ts` (добавить endpoints)

**Endpoints:**
```
POST /api/agents/spawn
POST /api/agents/:id/terminate
GET  /api/agents/templates
```

**Agent Template:**
```json
{
  "id": "scout-template-001",
  "name": "Scout Agent",
  "baseAdapter": "claude-sonnet-4-5-20250929",
  "capabilities": ["research", "search", "context-gathering"],
  "tools": ["browser", "filesystem", "search"],
  "soul_path": "/trios/.trios/agents/scout/SOUL.md"
}
```

---

## 🚀 Phase 3: Task Queue

### 3.1 Database Schema
```sql
CREATE TABLE agent_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  priority INT DEFAULT 0,
  status TEXT DEFAULT 'pending',
  retry_count INT DEFAULT 0,
  max_retries INT DEFAULT 3,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  result JSONB
);

CREATE INDEX idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX idx_agent_tasks_priority ON agent_tasks(priority DESC, created_at ASC);
```

### 3.2 Task Queue Service
**Файл:** `apps/server/src/api/services/task-queue-service.ts`

**Methods:**
- `enqueueTask(agentId, taskType, payload, priority)`
- `dequeueNextTask(agentId)`
- `updateTaskStatus(taskId, status, result?)`
- `getTaskHistory(agentId, limit)`

### 3.3 Task Queue API
**Файл:** `apps/server/src/api/routes/tasks.ts`

**Endpoints:**
```
GET    /api/tasks              → список задач (фильтры: status, priority, agent)
POST   /api/tasks              → создать задачу
PUT    /api/tasks/:id          → обновить статус
DELETE /api/tasks/:id          → удалить задачу
GET    /api/tasks/queue/:agent → следующая задача для агента
```

---

## 🚀 Phase 4: Session Persistence

### 4.1 Сохранение сессий в PostgreSQL
**Файл:** `apps/server/src/agent/session-store.ts`

**Current:**
```typescript
private sessions = new Map<string, AgentSession>()
```

**New:**
```typescript
// Сохранять в DB при создании/обновлении
// Восстанавливать при старте сервера
// Добавлять TTL для cleanup старых сессий
```

**SQL:**
```sql
CREATE TABLE agent_sessions (
  conversation_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  browser_context JSONB,
  hidden_page_id INT,
  mcp_servers JSONB,
  working_dir TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_active_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
```

---

## 🚀 Phase 5: Agent Permissions (ACL)

### 5.1 Permissions Schema
```sql
CREATE TABLE agent_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  UNIQUE(agent_id, resource_type, resource_id, permission)
);
```

### 5.2 Permission Types
- `conversation:read` — читать чат
- `conversation:write` — писать в чат
- `task:assign` — назначать задачи
- `agent:spawn` — создавать агентов
- `memory:read` — читать память
- `memory:write` — писать в память

---

## 📅 Timeline

| Phase | Task | ETA |
|-------|------|-----|
| 1 | POST /api/chats | 30 мин |
| 2 | Agent spawn API | 1 час |
| 3 | Task queue | 2 часа |
| 4 | Session persistence | 1 час |
| 5 | ACL permissions | 1 час |

**Total:** ~5.5 часов

---

## 🎯 Next Action
Начинаю с **Phase 1.1** — POST /api/chats
