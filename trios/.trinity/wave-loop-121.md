# Wave 121 — 2026-09-01: карта поражения 12b97dedc — жертва одна, паттерн фикса уже в репо

Окно открыто (20 мин, дерево неподвижно, сосед молчит ~5 ч). Опция 3
волны 120: какие ещё гейты задел сплит модуля QueenCore.

## Замерено живьём (зелёное = измеренное)

- `make chain` → [OK] golden chain intact: **80 verdicts, spec and
  code agree** (компилирует ровно QueenRetryPolicy + QueenReviewDecision
  против Foundation — импортеров QueenCore в паре нет).
- `make t27-rings` → [OK] ring00_verilog: **14 rows checked**,
  iverilog-симуляция отвечает Swift-таблице (генерация из
  rings/T27-00/queen_core.t27).

## Прочитано (file:line)

- `make chain` рецепт: Makefile:710 — явная пара файлов, не find-глоб.
- `mutants-logic` (clade-e2e): rings/RUST-02/clade-e2e/src/main.rs:
  1123-1146 — «A suite whose sources import QueenCore needs the
  module» — строит/использует `.trinity/build/QueenCore`, определяя
  потребность посьюитно; модуль собирает `dev`. **Сосед научил
  clade-e2e модулю, но не тронул run_chat_sse_e2e.sh** — паттерн
  фикса сломанного оракула уже лежит в репо.

## Карта поражения (итог)

| Гейт | Статус | Доказательство |
|---|---|---|
| make test / mutants | МЁРТВ | волна 120: :91 один модуль × 6 импортеров |
| make chain | ЖИВ | замер сейчас: 80 verdicts [OK] |
| make t27-rings | ЖИВ | замер сейчас: 14 rows [OK] |
| make t27-lowering | ЖИВ | волна 117: EXIT=0 |
| make queen-core | ЖИВ | волна 120: 15 файлов [OK] |
| make make-dollars | ЖИВ | волны 119/120: [OK] |
| mutants-logic (clade-e2e) | спроектирован живым | main.rs:1140 module-aware (не гонялся этой волной — честная пометка) |
| make cassettes | 4 отказа ДО сплита | причина aa3b6fc14, к сплиту отношения не имеет |

## Сделано

- STATUS.md «Measured here»: добавлена строка `make test / make
  mutants -> DEAD since the QueenCore module split` с картой
  поражения и указанием на in-repo паттерн фикса (clade-e2e:1140).

## НЕ сделано (честно)

- mutants-logic НЕ прогнан (cargo + сюиты длиннее окна) — помечен
  «спроектирован живым» по чтению кода, не замером.
- Фикс run_chat_sse_e2e.sh не начат: мандат в tri handover, паттерн
  указан; чужая свежая архитектура.

## Три варианта сотрудничества на следующую волну

1. **Тихо и окно большое** → прогнать `make mutants-logic` (или
   clade-e2e напрямую) — закрыть последнюю «спроектирован-живым»
   клетку карты измерением.
2. **Сосед/владелец берёт мандат фикса сьюта** → после фикса первым
   ходом прогон 22-го мутанта.
3. **Кассетный фикс приземлился** → плоский make cassettes, первый
   зелёный (независим от карты).
