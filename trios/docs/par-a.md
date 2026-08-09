# Parallel Work in Trios

1. Parallel work begins with isolation. Each worker owns a branch, a working tree, and a specification that is narrow enough to verify in a single pass. No worker edits outside its declared paths; the Queen merges results and resolves conflicts after every turn. This contract keeps concurrent changes composable and keeps review tractable — a diff that touches one file is cheap to inspect, a diff that sprawls is not.

2. Communication flows through the specification, not through chat. Every task carries acceptance criteria, a boundary, and an out-of-scope section. Workers answer each criterion explicitly when they stop, because an unchecked criterion is not a pass. When something seems obviously needed but is not listed, the worker raises it rather than doing it quietly — unstated scope is where a review turns into an argument.

3. Verification is the last act, not an afterthought. A worker proves its work against the criteria before yielding the turn: files exist, sizes are met, content matches the intent. The Queen reviews against the same criteria before anything lands. This double check — worker self-verifies, Queen re-verifies — is what lets parallel agents ship with confidence instead of hope.
