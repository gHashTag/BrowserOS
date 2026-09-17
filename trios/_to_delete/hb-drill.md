# Heartbeat Drill

> Issue [gHashTag/trios#1246](https://github.com/gHashTag/trios/issues/1246)

Ten paragraphs about long silences, the marks that break them, and what
happens when the marks are gone.

---

1. A worker that streams has two states the outside world cares about:
   *working* and *hung*. While output flows — tokens, characters, partial
   results — the distinction is trivial: there is data, therefore the worker
   is alive. The trouble begins the moment the data stops. A pause of ten
   seconds might be the model thinking; a pause of five minutes might be a
   dead socket. Without additional signal the observer is left guessing,
   and a guess that the worker is still working is no better than a guess
   that it has hung. Long silence is the gap in which certainty dies.

2. The heartbeat mark closes that gap. While the worker's stream is flowing
   the system writes a periodic mark into the record — a small, structured
   note that says three things: **which task** the worker is on, **how much
   wall-clock time has elapsed** since the stream started, and **how many
   characters have been received** so far. The mark is not content from the
   model; it is infrastructure from the harness, stamped alongside the
   stream so that every observer — human, dashboard, watchdog — can see that
   the pipe is live even when the model has nothing to say.

3. The cadence is half a minute. Every thirty seconds of active streaming
   produces exactly one heartbeat mark, no more, no less. Thirty seconds is
   long enough that the marks do not drown out real output, yet short enough
   that two consecutive marks without a gap confirm the stream is still
   advancing. If an observer sees a mark at *T + 0:30* and another at
   *T + 1:00*, the stream ran continuously through that minute. The interval
   is a contract: marks arrive on schedule because the stream is on
   schedule, and their absence is meaningful precisely because their
   presence is regular.

4. Each mark carries the task identifier so that concurrent workers can be
   told apart. If two workers run in parallel and one falls silent, the
   task name in the heartbeat trail makes it immediately clear *which*
   worker has stopped, not just *that a* worker has stopped. The elapsed
   counter gives the age of the stream — not the age of the task, not the
   age of the process, but the age of *this particular stream*, measured
   from the moment the first byte flowed. And the character count gives a
   second axis of progress: even when wall-clock time keeps ticking, a
   rising character count proves that the worker is not merely alive but
   productive.

5. The marks stop when the stream stops. This is not a configurable
   timeout or a heuristic — it is a mechanical consequence of tying the
   heartbeat to the stream lifecycle. The stream opens, the timer starts;
   the stream closes, the timer stops. There is no trailing mark after the
   final byte, no farewell pulse, no "done" heartbeat. The last mark the
   observer sees is the last one that fired while the stream was still
   open, and then silence — a silence that means *finished*, not *failed*.
   The distinction between post-stream silence and mid-stream silence is
   the distinction between a worker that has completed its work and one
   that has stalled inside it, and it is the stream's open-or-closed state
   that disambiguates them.

6. Before the heartbeat drill, a silence of any length was ambiguous. The
   observer could see that no characters had arrived for ninety seconds,
   but they could not tell whether the worker was thinking hard or had
   crashed quietly. The absence of output was the only evidence, and
   absence proves nothing: the stream might be slow, the network might be
   congested, the model might be generating a long internal chain of
   reasoning before emitting its first visible token. With the heartbeat
   drill in place, silence longer than a minute takes on a precise meaning.
   It no longer means *no record has been written*; it means *the stream
   itself has gone quiet* — the pipe that should be carrying marks every
   thirty seconds has stopped carrying anything at all, and the absence of
   a mark that was expected at *T + 1:30* is now as informative as the
   presence of the ones that came before.

7. The precision matters because it changes what a watchdog is allowed to
   conclude. Before heartbeats, a watchdog that killed a worker after
   sixty seconds of silence was guessing — it might be killing a worker
   that was about to emit a megabyte of output. After heartbeats, the same
   watchdog can reason causally: if the last heartbeat arrived at *T + 1:00*
   and none has arrived by *T + 2:00*, the stream has missed two scheduled
   marks. Two missed marks is not a guess; it is a measured failure of the
   stream to advance, and acting on it is a response to evidence, not a
   reaction to impatience. The heartbeat turns silence from a symptom into
   a signal.

8. The indistinguishability test is the proof that the marks are doing
   their job. Strip them out — remove every heartbeat from the record, let
   the stream write only its model-produced content — and the two states
   collapse back together. A worker that is thinking hard looks identical
   to a worker that has hung: no output, no mark, no way to tell. The
   heartbeat exists *because* the indistinguishability is the natural state
   of a silent stream. It is not a convenience or a log-level preference;
   it is the only mechanism that prevents silence from meaning two things
   at once. If removing the marks does not restore ambiguity, the marks
   were not the disambiguator and something else was already carrying the
   signal — in which case the heartbeat is redundant and the drill has
   failed to identify its own purpose.

9. Consider what the character count in each mark reveals that the
   wall-clock alone cannot. Two consecutive marks at *T + 2:00* and
   *T + 2:30* might show elapsed time advancing normally, but if the
   character count has not moved between them, the worker is alive but
   stalled — the socket is open, the timer is firing, but no new bytes
   have arrived. This is a third state, neither *working* nor *hung* but
   *waiting*: the stream has not closed, yet it has not advanced. The
   heartbeat surfaces this state by pairing time and data in every mark,
   giving the observer two independent channels of progress. A mark with
   rising characters and rising time means *productive*. A mark with
   rising time and flat characters means *stuck*. A missing mark means
   *dead*. Three diagnoses, one mechanism.

10. The heartbeat drill is, in the end, a discipline of evidence. It does
    not make workers faster, it does not prevent hangs, and it does not
    add any capability the worker did not already have. What it does is
    ensure that the gap between *working* and *hung* — a gap that is wide
    and obvious when output flows — remains visible during the moments
    when output does not flow. Every thirty seconds, the mark says: *the
    stream is open, the task is this, the time is that, the bytes are
    these many.* Remove that voice and the silence returns to its old
    ambiguity. Keep it, and silence becomes legible: a pause is just a
    pause while the marks keep coming, and only when they stop does the
    silence become a problem worth acting on.

---

*Authored for `queen/1246-write-docs-hb-drill-md-with-ten-numbered`.*
