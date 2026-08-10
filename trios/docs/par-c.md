# File Boundaries — `par-c`

1. Each source file in the Trios project owns exactly one architectural layer. A file that mixes concerns from two layers — say, presentation and infrastructure — becomes impossible to test in isolation and impossible to reason about during code review. When a new feature spans multiple layers, it must be split across multiple files rather than crammed into a single one that "works."

2. Files must stay within a readable size. A source file longer than roughly 400 lines is a signal that responsibilities have accumulated and a split is overdue. Large files slow down navigation, make merge conflicts more likely, and hide structure that smaller files reveal at a glance. Prefer several focused files over one omnibus file, even if the omnibus file is technically valid.

3. Naming and placement follow the onion-ring architecture: Core files live at the project root, Infrastructure files sit one level deeper, Application files above the Presentation layer, and so on. A file placed in the wrong ring breaks dependency direction and creates import cycles. When in doubt, check which layers import what — if a file in an inner ring imports from an outer ring, the boundary has been violated and the file must move.
