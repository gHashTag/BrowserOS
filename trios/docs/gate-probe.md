# Gate Probe

A review gate is a checkpoint that blocks a pull request from merging until a designated reviewer — human or automated — approves the change. Gates enforce minimum quality bars (tests pass, lint clean, spec met) before code reaches the trunk branch. They are most useful when the criteria are unambiguous: a machine can check "tests pass" but struggles with "the code reads well," so effective gates pair mechanical checks with a short human judgment step.
