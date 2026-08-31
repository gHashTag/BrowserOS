# Wave 122 — 2026-09-01: mutants-logic зелёный измерением; вторая причина ERROR — устаревший артефакт модуля

Окно открыто (20 мин, сосед молчит ~6 ч, harness-лок FREE). Очередной
пункт карты: закрыть клетку mutants-logic измерением.

## Ход (два прогона, обе улики в .trinity)

1. `make mutants-logic` (wave-122-mutants-logic.log) → ERROR:
   «QueenDelegation suite never ran», 7 из 8 логик-сюит [OK], у
   QueenDelegation — compile failed. Отчёт
   (.trinity/e2e/report_prod_1788209411.md:16): «module compiled with
   Swift 6.0.3 cannot be imported by the Swift 6.3.3 compiler:
   .trinity/build/QueenCore/QueenCore.swiftmodule».
2. Артефакт датирован Aug 31 20:44 (чужой вечерний build.sh), собран
   тулчейном 6.0.3; дефолтный — 6.3.3. Продюсер — build.sh:607-613.
3. Пересобрал артефакт текущим тулчейном тем же вызовом swiftc
   (15 QUEEN_CORE_FILES, -emit-module -emit-library; err = 0 ошибок).
   Это build-продукт, не исходник; следующий прогон build.sh всё равно
   перепишет его.
4. Повторный `make mutants-logic` (wave-122-mutants-logic2.log) →
   **[OK] every logic-suite mutation was caught (2)** — оба мутанта
   QueenSalience пойманы сюитой QueenDelegation (failed twice).

## Карта поражения 12b97dedc — финал

| Гейт | Статус | Волна |
|---|---|---|
| make test / mutants (chat e2e) | МЁРТВ | 120 |
| chain / t27-rings / lowering / queen-core / make-dollars | ЖИВ | 117/121/120 |
| **mutants-logic (clade-e2e)** | **ЖИВ — измерено** | **122** |
| cassettes | 4 отказа, к сплиту не относятся | давно |

## Латентная мина (записана в доску)

build.sh эмитит модуль тем тулчейном, под которым его запустили;
clade-e2e компилирует сюиты дефолтным. Если владелец/сосед гонит
build.sh из-под 6.0.3 (пин DEVELOPER_DIR?), а сюиты — из-под 6.3.3,
mutants-logic снова упадёт на import. Соглашение о тулчейне —
владельческое решение; симптом и лекарство (пересборка артефакта)
теперь на доске.

## НЕ сделано (честно)

- Фикс chat-e2e скрипта не начат (мандат в handover, паттерн в репо).
- 22-й мутант остаётся нескорируемым до фикса сьюта.

## Три варианта сотрудничества на следующую волну

1. **Сосед/владелец чинит chat-e2e скрипт по мандату** → 22-й мутант
   первым ходом после фикса.
2. **Кассетный фикс приземлился** → плоский make cassettes.
3. **Тихо** → tri-ускорение: подкоманда `tri mutants-logic-refresh`
   (пересборка артефакта модуля + прогон) — сценарий этой волны
   одной командой, если рассинхрон тулчейнов повторится.
