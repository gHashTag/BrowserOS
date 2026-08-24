# T27 Wave Loop - Plan WAVE-069

Domain: улики вместо гипотез. Прошлая волна ограничила класс зависаний
(watchdog), но десятичасовой wedge остался безымянным по механизму; тихое
окно для гейта открылось прямо на старте волны.

## Audit - weak spots

| ID | Weak spot | Evidence |
|----|-----------|----------|
| W1 | **Watchdog убивает молча.** Убийство по бюджету не оставляет улик: что висело, чьи дети, какой глубины — неизвестно. Ночь 2026-08-24 разбиралась по памяти ps-вывода, снятого вручную часами позже. | Makefile:1813 (старая форма `kill -TERM` без дампа) |
| W2 | **Механизм wedge не найден.** Рецепт кассет не содержит `$(MAKE)` — вложенный `make check` не из текста рецепта; parentage (рецепт→субшелл→make check) наблюдён, но не объяснён. Нужны данные с места, а не дедукция. | grep по рецепту cassettes: 0 вхождений $(MAKE); ночное наблюдение PID 10055→10056→10057 |
| W3 | **Тихое окно гейта не поймано.** cassettes+mutants всё ещё partial на доске; окна открываются редко и ненадолго. | STATUS.md `-> partial 2026-08-24` |

## Competitor research

- [Debugging a Flaky Test with Replay (Replay.io)](https://www.replay.io/blog/debugging-a-flaky-test-with-replay):
  record/replay ради улики постфактум. Takeaway: наш watchdog-дамп —
  lite-версия той же идеи, снимок в момент убийства вместо полной записи.
- [Cypress Test Replay](https://docs.cypress.io/cloud/features/flaky-test-management):
  авто-сбор улик при фейле — продуктовая фича. Takeaway: улика должна
  собираться сама, не «кто-нибудь потом посмотрит ps».
- [Harness: flaky quarantine](https://www.harness.io/blog/flaky-tests-the-quiet-killer-of-productivity-in-your-ci-pipeline):
  изоляция флаков вместо падения конвейера. Takeaway на будущее: кассеты с
  contention-флейками заслуживают карантина, а не красного гейта.

## Plan

1. W1 → watchdog пишет двухуровневый ps-снимок дерева перед TERM.
2. W3 → поймать окно: запустить cassettes немедленно на старте волны.
3. W2 → после появления дампа (первое срабатывание) — диагноз по данным.

## Report

- **W1 сделан и доказан изолированно.** Новая форма watchdog'а проверена
  standalone дважды: убийство на 3-й секунде (exit 124), в выводе — сам
  шелл, дети, внуки. `make -n` показывает верное расширение ($$$$/pgrep
  доходят до оболочки), `make make-dollars` — [OK]. Live-срабатывание
  случится при первом воспроизведении зависания; честно: до того момента
  форма доказана тестом и расширением, не боем.
- **W3 в процессе на момент записи.** Кассеты запущены на старте волны в
  тихом окне (локи свободны, гейтов нет); бюджет watchdog 30 минут.
  Итог будет в итерации 76 журнала — доска дописывается по факту.
- **W2 готов к работе:** гипотеза «вложенный make из текста рецепта»
  отвергнута грепом; следующий шаг — чтение дампа, когда watchdog впервые
  сработает.

## Three options for the next wave

1. **Разбор первого дампа.** Если watchdog за ночь сработал — в логе
   кассет лежит дерево: назвать механизм wedge по данным и закрыть причину.
2. **mutants-changed в тихое окно.** Кассеты этой волны плюс мутанты =
   полный REAL_EXIT для STATUS.md; если окно закрылось — вернуться к
   одиночным шагам.
3. **Карантин contention-кассет.** По мотивам Harness.io: кассета, упавшая
   из-за соседа, не должна красить гейт — пометить и ретрай, отличая
   OBSERVED collision от настоящего фейла.

## Улика (живой захват, 2026-08-24 ~12:39)

```
  PID  PPID ELAPSED COMMAND
33047 33039   12:36 /Applications/Xcode.app/Contents/Developer/usr/bin/make cassettes
33561 33047   12:30 /bin/bash -c : "Serialised against every other harness run in this checkout."; : "Several agents share this tree and each runs `make check`. Two"; : "cassette runs drive the SAME trios-test.app and each ends every"; : "cassette with pkill on that bundle path, so they terminate each"; : "other's replay. Measured 2026-08-23: a run died with"; : "'make: *** [cassettes] Terminated: 15' while a second run was 40"; : "seconds into its own cassettes step. Nothing was broken; the two"; : "runs were killing each other, and the signal reads like a crash."; : "Waits rather than refusing. Both runs are legitimate and neither"; : "agent knows about the other, so failing the second one turns a"; : "scheduling collision into a red gate somebody has to investigate."; waited=0; while :; do \011owner_pid=$(cat "/tmp/trios_harness.lock/pid" 2>/dev/null || true); \011if mkdir "/tmp/trios_harness.lock" 2>/dev/null; then break; fi; \011if [ -n "$owner_pid" ] && ! kill -0 $owner_pid 2>/dev/null; then \011\011echo "[INFO] reclaiming harness lock from dead PID $owner_pid"; \011\011rm -rf "/tmp/trios_harness.lock"; continue; \011fi; \011if [ $waited -ge 1800 ]; then \011\011echo "[FAIL] another harness run has held /tmp/trios_harness.lock for 1800s"; \011\011echo "       (owner PID $owner_pid). Not waiting further."; \011\011exit 1; \011fi; \011if [ $waited = 0 ]; then \011\011echo "[cassettes] another harness run holds the lock (PID $owner_pid); waiting"; \011fi; \011sleep 5; waited=$((waited + 5)); done; : "PPID, not $$. Every line of a make recipe is its own shell, so"; : "this shell's PID is dead a moment after it is written and the next"; : "run would reclaim the lock as abandoned while the target still"; : "holds it. PPID is make itself, which lives for the whole target -"; : "so a run killed mid-cassette still leaves a PID that is genuinely"; : "dead, and the reclaim above is honest rather than a formality."; echo $PPID > "/tmp/trios_harness.lock/pid"; [ $waited -gt 0 ] && echo "[cassettes] acquired the harness lock after ${waited}s" || true
33562 33561   12:30 /bin/bash -c : "Serialised against every other harness run in this checkout."; : "Several agents share this tree and each runs `make check`. Two"; : "cassette runs drive the SAME trios-test.app and each ends every"; : "cassette with pkill on that bundle path, so they terminate each"; : "other's replay. Measured 2026-08-23: a run died with"; : "'make: *** [cassettes] Terminated: 15' while a second run was 40"; : "seconds into its own cassettes step. Nothing was broken; the two"; : "runs were killing each other, and the signal reads like a crash."; : "Waits rather than refusing. Both runs are legitimate and neither"; : "agent knows about the other, so failing the second one turns a"; : "scheduling collision into a red gate somebody has to investigate."; waited=0; while :; do \011owner_pid=$(cat "/tmp/trios_harness.lock/pid" 2>/dev/null || true); \011if mkdir "/tmp/trios_harness.lock" 2>/dev/null; then break; fi; \011if [ -n "$owner_pid" ] && ! kill -0 $owner_pid 2>/dev/null; then \011\011echo "[INFO] reclaiming harness lock from dead PID $owner_pid"; \011\011rm -rf "/tmp/trios_harness.lock"; continue; \011fi; \011if [ $waited -ge 1800 ]; then \011\011echo "[FAIL] another harness run has held /tmp/trios_harness.lock for 1800s"; \011\011echo "       (owner PID $owner_pid). Not waiting further."; \011\011exit 1; \011fi; \011if [ $waited = 0 ]; then \011\011echo "[cassettes] another harness run holds the lock (PID $owner_pid); waiting"; \011fi; \011sleep 5; waited=$((waited + 5)); done; : "PPID, not $$. Every line of a make recipe is its own shell, so"; : "this shell's PID is dead a moment after it is written and the next"; : "run would reclaim the lock as abandoned while the target still"; : "holds it. PPID is make itself, which lives for the whole target -"; : "so a run killed mid-cassette still leaves a PID that is genuinely"; : "dead, and the reclaim above is honest rather than a formality."; echo $PPID > "/tmp/trios_harness.lock/pid"; [ $waited -gt 0 ] && echo "[cassettes] acquired the harness lock after ${waited}s" || true
33563 33562   12:30 /Applications/Xcode.app/Contents/Developer/usr/bin/make check
```

## Улика-2: рекурсия вглубь (12:45, три уровня)
```
33047 33039   15:38 /Applications/Xcode.app/Contents/Developer/usr/bin/make cassettes
33561 33047   15:32 /bin/bash -c : "Serialised against every other harness run in this checkout."; : "Several agents share this tree and each runs `ma
33562 33561   15:32 /bin/bash -c : "Serialised against every other harness run in this checkout."; : "Several agents share this tree and each runs `ma
33563 33562   15:32 /Applications/Xcode.app/Contents/Developer/usr/bin/make check
45968 33563   10:21 /bin/bash -c : "Serialised against every other harness run in this checkout."; : "Several agents share this tree and each runs `ma
45969 45968   10:21 /bin/bash -c : "Serialised against every other harness run in this checkout."; : "Several agents share this tree and each runs `ma
45970 45969   10:21 /Applications/Xcode.app/Contents/Developer/usr/bin/make check
75796 45970   05:42 /bin/bash -c : "Serialised against every other harness run in this checkout."; : "Several agents share this tree and each runs `ma
75797 75796   05:42 /bin/bash -c : "Serialised against every other harness run in this checkout."; : "Several agents share this tree and each runs `ma
```
