# Queen connectivity vocabulary

Issue #1389. The rule that decides whether a worker turn ended in a
connectivity failure was written twice in Swift - once in
`trios/rings/SR-02/QueenWorkerRunner.swift` and once in
`trios/rings/SR-02/ChatViewModel.swift` - and the two copies disagreed:
the view model carried a needle the runner lacked, and neither copy
recognised the wording the production transport itself renders.

The gate `trios/tools/queen-connectivity-vocabulary.mjs` reads every value
below from the Swift sources at run time - needles, the TransportError
case thrown where a URLError is erased, the number of those erasure
sites, the case's rendered description, and the e2e instrument's wording.
Nothing in the tool's own source spells out any of them, so it cannot
become a third drifting copy. It reads and prints only; it writes
nothing.

## The finding: the run before the Swift edit

```
$ node trios/tools/queen-connectivity-vocabulary.mjs > /tmp/before.txt; echo "exit=$?"
exit=1
$ cat /tmp/before.txt
RUNNER NEEDLES: could not connect | unable to connect | could not be found
VIEWMODEL NEEDLES: could not connect | cannot connect | unable to connect | could not be found
URLERROR ERASURE SITES: 1
TRANSPORT DESCRIPTION TransportError.connectionFailed = "Connection failed"
INSTRUMENT DESCRIPTION "Could not connect to the server"
FAIL: needle-superset "cannot connect" present in trios/rings/SR-02/ChatViewModel.swift but absent from trios/rings/SR-02/QueenWorkerRunner.swift
FAIL: transport-case-covered TransportError.connectionFailed renders "Connection failed" and no runner needle matches it
FAIL: instrument-not-ahead-of-transport "Could not connect to the server" is matched by runner needles while "Connection failed" is not
OUT OF BOUNDARY: trios/rings/SR-02/ChatViewModel.swift does not cover "Connection failed" either; that file is held by open issue #1133 and is not this change's to edit
$ grep -c '^FAIL: ' /tmp/before.txt
3
```

Three failures, one per rule the tool holds:

1. **needle-superset** - the runner was missing the `cannot connect`
   needle the view model carries. This is the drift that already
   happened.
2. **transport-case-covered** - `SSETransport` erases every URLError
   into `TransportError.connectionFailed`, which renders as
   `Connection failed`, and no runner needle matched that string. The
   production path could never reach the true branch.
3. **instrument-not-ahead-of-transport** - the only string that ever did
   reach the true branch was the e2e instrument's
   `Could not connect to the server`, which matched `could not connect`.
   A test that passes on a vocabulary the transport never speaks was the
   proof that hid the gap.

## The fix: the run after the Swift edit

Two needles were added to
`QueenWorkerRunner.isConnectivityFailure` - `cannot connect`, restoring
the mirror of the view model, and `connection failed`, recognising the
transport's own rendered wording - and nothing else changed in Swift.

```
$ node trios/tools/queen-connectivity-vocabulary.mjs; echo "exit=$?"
RUNNER NEEDLES: could not connect | cannot connect | unable to connect | could not be found | connection failed
VIEWMODEL NEEDLES: could not connect | cannot connect | unable to connect | could not be found
URLERROR ERASURE SITES: 1
TRANSPORT DESCRIPTION TransportError.connectionFailed = "Connection failed"
INSTRUMENT DESCRIPTION "Could not connect to the server"
OUT OF BOUNDARY: trios/rings/SR-02/ChatViewModel.swift does not cover "Connection failed" either; that file is held by open issue #1133 and is not this change's to edit
exit=0
```

No `FAIL:` line, exit 0, and the view model's own gap is reported rather
than skipped.

## Facts recorded for the follow-up

- `SSETransport.swift:73` throws the same `connectionFailed` case when a
  403 retry finds no local auth provider
  (`guard localAuthProvider != nil else { throw TransportError.connectionFailed }`),
  so the new `connection failed` needle also classifies that
  configuration fault as connectivity rather than as a worker failure.
  That is a classification choice worth a reviewer's eye: a missing auth
  provider is now logged as `queen.worker.finish`, not
  `queen.worker.failed`.
- The view model's identical gap is deliberately not fixed here.
  `trios/rings/SR-02/ChatViewModel.swift` is held by open issue #1133
  and is a read-only input to this change; the tool prints its gap on
  the `OUT OF BOUNDARY:` line above so it cannot look settled.
- The only path that ever reached the true branch before this fix was
  the `TRIOS_E2E_TRANSPORT_FAILURE` instrument, reached only when that
  variable is set to `connectivity`. With it unset, a mid-turn network
  drop was logged as `queen.worker.failed` for a failure nobody
  committed, and `ChatViewModel.handleWorkerFinished` took the
  genuine-failure branch the #1219 comment says that branch exists to
  prevent.
- The durable fix is matching the `TransportError` case instead of its
  rendered English - string matching is what drifted and can drift
  again. It could not be done here because there is no Swift compiler in
  the worker container. This change was not compiled, built or
  unit-tested; the proof is the before-and-after runs quoted above.

## The Swift edit

`QueenWorkerRunner.isConnectivityFailure` gained two lines and nothing
else was touched:

```diff
         let lowercased = message.lowercased()
         return lowercased.contains("could not connect")
+            || lowercased.contains("cannot connect")
             || lowercased.contains("unable to connect")
             || lowercased.contains("could not be found")
+            || lowercased.contains("connection failed")
     }
```
