# Project Instructions

## Docs Image Workflow

When updating documentation that involves new screenshots or images:

1. Prompt the user to copy the image to their clipboard (Cmd+C).
2. Save the clipboard image to a path under `docs/images/` at the
   repository root, using the image tool available in the session. There is
   no helper script for this step in this repository: the command this
   section used to give ran a Python helper that has never been tracked on
   any branch, so an agent that followed it verbatim always hit a missing
   file and had to invent a substitute on the spot.
3. Pick a descriptive name for the file under `docs/images/`, for example
   `docs/images/agent-step.png` for a screenshot of one agent step, and
   reference it from the doc being updated.

The workflow is unchanged in intent: one copy, one save, and the image
lands in the docs folder without manual file management.
