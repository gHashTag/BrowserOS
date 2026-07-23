# TRIOS-999-MENU-001 - Make the 999 triangle the primary Trios menu

## Intent

The canonical Queen 27-petal triangle is the only primary navigation surface.
Trios workspaces open inside logically matching petals instead of appearing in
a competing tab strip above the 999 menu.

## Route contract

| Trios workspace | Petal | Realm | 999 world |
| --- | ---: | --- | --- |
| Chat | 0 | RAZUM | CHAT |
| Models | 1 | RAZUM | MODELS |
| Terminal | 13 | MATERIYA | TERMINAL |
| Git | 14 | MATERIYA | GIT |
| Mesh | 16 | MATERIYA | MESH |
| Settings | 17 | MATERIYA | SETTINGS |

Queen is not a separate destination. The 999 triangle itself is Queen and the
home state. The remaining 21 petals keep their canonical Queen routes.

## Behavior

- Remove the top Trios tab strip.
- Keep the compact title/status/full-screen controls.
- Open hosted Trios workspaces inside the Queen navigation frame.
- The Queen back control and the title brand return to the 999 menu.
- Cmd+1 through Cmd+6 open Chat, Models, Git, Terminal, Mesh, and Settings.
- A model-management request opens the Models petal.
- Returning to Chat requests the latest conversation position.
- Hosted tooltip labels override only their assigned petals.

## Verification

- Route policy tests prove exact indices, uniqueness, realms, and shortcuts.
- All Queen tests pass.
- The Trios embedding test passes.
- Trios builds and signs with the bundled QueenUILib.
- Compact and full-screen screenshots show one primary 999 navigation surface.
- Each hosted workspace opens from its mapped petal.
