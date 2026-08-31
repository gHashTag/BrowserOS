# Wave 128 — 2026-09-01: один корень на 10 красных — глобальный исполнитель молча подменял projectRoot

Окно открыто (20 мин, сосед молчит ~13 ч). Диагноз коммиттер-кластера
(10 из 12 красных волны 127).

## Диагноз (эмпирика + чтение, до file:line)

1. Воспроизвёл шаги сценария в шелле на scratch-репо (init/branch/
   snapshot/add/write-tree/diff/commit-tree/update-ref) — ВСЁ работает:
   git не при чём.
2. Читаю цепочку Swift: runGitResult (QueenBranchCommitter.swift:1314)
   гоняет git с `workDir: repositoryRoot(projectRoot:)`, а
   repositoryRoot (:1268) = `QueenGit.executor.repositoryRoot ??
   projectRoot` — корень, ГЛОБАЛЬНО открытый исполнителем в настоящем
   чекауте. Для scratch-projectRoot executor-ответ молча подменяет
   аргумент → вся git-проводка сценария уезжает в настоящий репо →
   `rev-parse refs/heads/queen/1-test` («ветка только в scratch»)
   падает → committed=false во всех scratch-сценариях разом.

Контейнерная эпоха соседа ввела глобального исполнителя; сценарии
писались до него, а сьют с тех пор не запускался (мёртвый скрипт) —
регрессию никто не видел 4+ дня.

## Фикс (минимальный, семантика API сохранена)

repositoryRoot: корень исполнителя — факт о ЕГО репозитории;
чужой projectRoot (не префикс) не переукореняется:

    guard let root = QueenGit.executor.repositoryRoot else { return projectRoot }
    return projectRoot.hasPrefix(root) ? root : projectRoot

Поведение настоящего проекта не меняется (projectRoot внутри root →
root, как было).

## Проверено измерением

`bash tests/swift/run_chat_sse_e2e.sh` (wave-128-e2e.log):
**2 of 968 failed** (было 12). Все 10 коммиттер/отпечаток-проверок
зеленели. Остались 2 marshal-красных («request body messages array
missing or malformed», «memory-aware request body is missing») —
тело запроса соседа сменило форму; поля message/mode/origin/
conversationId проходят, массива messages нет — отдельный диагноз
(ChatRequestBuilder), НЕ начат в этой волне (окно давно истекло).

## НЕ сделано

- Marshal-2 кластер (следующая волна или сосед).
- 22-й мутант: бейзлайн 966/968 — всё ещё не зелёный.
- Пересборка trios-test.app → девятое live-verify (коммиттер-фикс
  входит в состав будущей пересборки).

## Три варианта сотрудничества на следующую волну

1. **Marshal-2 диагноз**: где ChatRequestBuilder собирает тело и куда
   делся массив messages (или что теперь несёт историю) → обновить
   сценарий или зарегистрировать регрессию соседу.
2. **Сосед просыпается** → показать: repositoryRoot-фикс, drill-
   контракт, расхождение 11 vs 15 — три моих правки в их зоне с
   измеренными основаниями.
3. **Зелёный бейзлайн достигнут** (marshal-2 закрыт) → первым делом
   прогон 22-го мутанта + пересборка trios-test.app + live-verify.
