# Parallel Work (Branch A)

Parallel work means breaking a big task into smaller pieces and tackling them at the same time. When the pieces are independent, you finish faster — three workers on disjoint slices can cut a six-hour task down to two hours of wall-clock time.

The catch is independence. If two workers edit the same file or one depends on the other's output, they are no longer parallel. They become serialized, with coordination overhead layered on top. The Trios project solves this by giving each worker a dedicated Git branch and a narrow, explicit scope. The Queen assigns slices, tracks progress, and merges results. Workers never edit outside their assigned paths and never coordinate with each other directly — all routing goes through the Queen.

Pitfalls are real: hidden coupling between seemingly separate tasks, review bottlenecks when every branch funnels through one reviewer, and merge thrash when branches touch overlapping code. The model works when boundaries are explicit, tasks are genuinely independent, and coordination stays centralized.
