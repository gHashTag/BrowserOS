# Orphan Drill

A worker that restarts mid-flight is an orphan: its in-memory plan vanishes, but every edit it already wrote survives in the task branch.

The journal records how many files were rescued from the orphaned run.

The verification suite fails if any orphaned edits go missing again.
