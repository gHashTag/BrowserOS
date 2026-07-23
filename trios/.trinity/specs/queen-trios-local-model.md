# QUEEN-TRIOS-MODEL-001 - Queen local model handoff

## Intent

When canonical Queen runs inside Trios, Queen Chat must use the local Ollama
catalog already configured by Trios when no usable Queen cloud model exists.

## Contract

- Preserve an already available Queen model selection.
- Otherwise prefer a previously saved Queen Ollama selection when available.
- Otherwise prefer `trios.model.ollama.selection` from the shared app defaults.
- Otherwise select the first discovered Ollama model.
- Recheck provider connectivity whenever automatic selection changes the model.
- Never copy or expose API keys.

## Verification

- Selection policy tests cover preservation, Trios preference, and fallback.
- All Queen tests pass.
- Trios rebuilds and signs with the updated QueenUILib.
- Queen Chat selects the same Ollama model as Trios and reports online.
