// t27core - the command-line face of RING-00.
//
// THIS FILE IS PLUMBING, NOT A RULE. L0 has not been broken here.
//
// Every decision below is answered by calling a `pub fn` in
// rings/T27-00/generated/queen_core.rs, which is generated from
// rings/T27-00/queen_core.t27 by t27c. Nothing in this file decides anything:
// it parses argv into integers and booleans, hands them to the generated
// function, and prints what came back. If you find yourself wanting to add an
// `if` that changes an answer, it belongs in the .t27.
//
// Hand-written plumbing around a generated core is already precedented in this
// ring: tests/t27/ring00_parity.sh builds a bench exactly this way - two bare
// `rustc` invocations, the generated file first as `--crate-type lib`, then the
// hand-written half as its own crate with `--extern queen_core=<rlib>`. This
// shim follows that build, for the same reason: the ring's stated contract is
// bare rustc, no cargo and no dependencies, so a JSON parser or a serde
// derive would break it. That is also why the interface is argv in and
// `key=value` out - every input and output of the generated code is an integer
// or a bool, so argv is enough, and a dependency would buy nothing.
//
// Build (from the repository root):
//
//   rustc --edition 2021 --crate-type lib \
//         rings/T27-00/generated/queen_core.rs -o libqueen_core.rlib
//   rustc --edition 2021 rings/T27-00/shim/t27core.rs \
//         --extern queen_core=libqueen_core.rlib -o t27core
//
// Contract:
//
//   t27core capacity   <running>
//   t27core review     <total_criteria> <judged> <unmet> <committed_files> <prior_send_backs>
//   t27core retry      <real_attempts>
//   t27core merge      <rollup> <mergeable 0|1> <is_draft 0|1> <checks_configured 0|1>
//   t27core counts     <kind>
//   t27core constants
//
// Exit 0 on success, printing `key=value` pairs one per line on stdout.
// Exit 2 on a bad argument count or an unparsable integer, printing
// `error=<what>` as the first line of stderr and NOTHING on stdout - never a
// default. A decision core that guesses at its input is worse than one that
// refuses.

#![forbid(unsafe_code)]

/// The generated artifact, embedded verbatim at BUILD time.
///
/// This is how `t27core constants` gets its list. It is not a second copy of
/// the law that someone must remember to update: it is the same file the
/// linked `queen_core` crate is compiled from, read by the compiler at the
/// moment this shim is built. Add, rename or delete a `pub const` in the .t27
/// and this binary's output follows without a line changing here - which is
/// the duplication this whole ring exists to end.
const GENERATED_SOURCE: &str = include_str!("../generated/queen_core.rs");

/// Refuse. `error=<what>` is the first line of stderr; stdout stays empty.
fn refuse(what: String) -> ! {
    eprintln!("error={}", what);
    std::process::exit(2);
}

/// An integer argument, or a refusal. Never a default.
fn int_arg(name: &str, raw: &str) -> i32 {
    match raw.parse::<i32>() {
        Ok(value) => value,
        Err(_) => refuse(format!("<{}> is not an integer: '{}'", name, raw)),
    }
}

/// A boolean argument, spelled 0 or 1. Anything else is a refusal: `2` is not
/// "probably true", and `true` is not a spelling this contract accepts.
fn bool_arg(name: &str, raw: &str) -> bool {
    match raw {
        "0" => false,
        "1" => true,
        _ => refuse(format!("<{}> must be 0 or 1, got '{}'", name, raw)),
    }
}

/// Exactly `want` arguments, or a refusal.
fn expect_arity(command: &str, args: &[String], want: usize, shape: &str) {
    if args.len() != want {
        refuse(format!(
            "{} takes {} argument(s), got {} - usage: t27core {} {}",
            command,
            want,
            args.len(),
            command,
            shape
        ));
    }
}

// --- Names -------------------------------------------------------------------
//
// The generated ring is integers and booleans by law, so the human-readable
// name of a verdict cannot come out of it. What CAN come out of it, and does,
// is which integer each name stands for: every arm below compares against the
// generated `pub const`, never against a number typed here. Renumber a verdict
// in the .t27 and these names follow it. An integer no constant claims is a
// refusal rather than a guess.

fn review_name(verdict: i32) -> &'static str {
    if verdict == queen_core::REVIEW_WAIT {
        "wait"
    } else if verdict == queen_core::REVIEW_ACCEPT {
        "accept"
    } else if verdict == queen_core::REVIEW_SEND_BACK {
        "send_back"
    } else if verdict == queen_core::REVIEW_ESCALATE {
        "escalate"
    } else {
        refuse(format!(
            "the ring returned review verdict {}, which no REVIEW_* constant names",
            verdict
        ));
    }
}

fn retry_name(verdict: i32) -> &'static str {
    if verdict == queen_core::RETRY_ATTEMPT {
        "attempt"
    } else if verdict == queen_core::RETRY_ESCALATE {
        "escalate"
    } else {
        refuse(format!(
            "the ring returned retry verdict {}, which no RETRY_* constant names",
            verdict
        ));
    }
}

fn merge_name(verdict: i32) -> &'static str {
    if verdict == queen_core::MERGE_APPROVE {
        "approve"
    } else if verdict == queen_core::MERGE_WAIT {
        "wait"
    } else if verdict == queen_core::MERGE_WAKE_WORKER {
        "wake_worker"
    } else if verdict == queen_core::MERGE_REFUSE {
        "refuse"
    } else {
        refuse(format!(
            "the ring returned merge verdict {}, which no MERGE_* constant names",
            verdict
        ));
    }
}

// --- Constants ----------------------------------------------------------------

/// Every `pub const` in the generated artifact, in source order.
///
/// The parse is deliberately strict and matches exactly the one shape t27c
/// emits (`pub const NAME: i32 = VALUE;`). A `pub const` line it cannot read
/// is a refusal, not a skip: silently dropping a constant would make this
/// subcommand quietly answer a smaller ring than the one that shipped.
fn generated_constants() -> Vec<(String, i32)> {
    let mut found: Vec<(String, i32)> = Vec::new();

    for (number, raw) in GENERATED_SOURCE.lines().enumerate() {
        let line = raw.trim();
        let rest = match line.strip_prefix("pub const ") {
            Some(rest) => rest,
            None => continue,
        };
        let body = match rest.strip_suffix(';') {
            Some(body) => body,
            None => refuse(format!(
                "the generated artifact has a pub const this shim cannot read at line {}: '{}'",
                number + 1,
                line
            )),
        };
        let (name, value) = match body.split_once(": i32 = ") {
            Some(pair) => pair,
            None => refuse(format!(
                "the generated artifact has a pub const this shim cannot read at line {}: '{}'",
                number + 1,
                line
            )),
        };
        let value: i32 = match value.trim().parse() {
            Ok(value) => value,
            Err(_) => refuse(format!(
                "the generated artifact declares {} as '{}', which is not an integer - \
                 the contract of `t27core constants` is NAME=<int>",
                name.trim(),
                value.trim()
            )),
        };
        found.push((name.trim().to_string(), value));
    }

    if found.is_empty() {
        refuse(
            "the generated artifact declares no pub const - printing nothing would report an \
             empty ring as a healthy one"
                .to_string(),
        );
    }

    found
}

/// The text embedded above and the `queen_core` rlib linked below are supposed
/// to be the same artifact, but nothing in the build makes that so: a stale
/// rlib would make this binary print constants it does not actually decide
/// with. `free_slots(0)` is `MAX_CONCURRENT_WORKERS` for every value the
/// generated function can take, so it is an anchor that reaches through the
/// link and can be compared with the embedded text.
fn assert_link_matches_source(constants: &[(String, i32)]) {
    const ANCHOR: &str = "MAX_CONCURRENT_WORKERS";

    let embedded = match constants.iter().find(|(name, _)| name == ANCHOR) {
        Some((_, value)) => *value,
        None => refuse(format!(
            "the generated artifact no longer declares {}, so this binary cannot check that the \
             library it links is the artifact it embeds",
            ANCHOR
        )),
    };
    let linked = queen_core::free_slots(0);
    if embedded != linked {
        refuse(format!(
            "the linked queen_core library disagrees with the embedded artifact: {}={} in the \
             source, but free_slots(0)={} from the library - this binary was built from two \
             different rings",
            ANCHOR, embedded, linked
        ));
    }
}

// --- Subcommands ---------------------------------------------------------------

fn run_capacity(args: &[String]) {
    expect_arity("capacity", args, 1, "<running>");
    let running = int_arg("running", &args[0]);
    println!("can_start_another={}", queen_core::can_start_another(running));
    println!("free_slots={}", queen_core::free_slots(running));
}

fn run_review(args: &[String]) {
    expect_arity(
        "review",
        args,
        5,
        "<total_criteria> <judged> <unmet> <committed_files> <prior_send_backs>",
    );
    let total_criteria = int_arg("total_criteria", &args[0]);
    let judged = int_arg("judged", &args[1]);
    let unmet = int_arg("unmet", &args[2]);
    let committed_files = int_arg("committed_files", &args[3]);
    let prior_send_backs = int_arg("prior_send_backs", &args[4]);

    let verdict = queen_core::review_verdict(
        total_criteria,
        judged,
        unmet,
        committed_files,
        prior_send_backs,
    );
    println!("verdict={}", verdict);
    println!("name={}", review_name(verdict));
}

fn run_retry(args: &[String]) {
    expect_arity("retry", args, 1, "<real_attempts>");
    let real_attempts = int_arg("real_attempts", &args[0]);
    let verdict = queen_core::retry_verdict(real_attempts);
    println!("verdict={}", verdict);
    println!("name={}", retry_name(verdict));
}

fn run_merge(args: &[String]) {
    expect_arity(
        "merge",
        args,
        4,
        "<rollup> <mergeable 0|1> <is_draft 0|1> <checks_configured 0|1>",
    );
    let rollup = int_arg("rollup", &args[0]);
    let mergeable = bool_arg("mergeable", &args[1]);
    let is_draft = bool_arg("is_draft", &args[2]);
    let checks_configured = bool_arg("checks_configured", &args[3]);

    let verdict = queen_core::merge_verdict(rollup, mergeable, is_draft, checks_configured);
    println!("verdict={}", verdict);
    println!("name={}", merge_name(verdict));
}

fn run_counts(args: &[String]) {
    expect_arity("counts", args, 1, "<kind>");
    let kind = int_arg("kind", &args[0]);
    println!(
        "counts_against_issue={}",
        queen_core::counts_against_issue(kind)
    );
}

fn run_constants(args: &[String]) {
    expect_arity("constants", args, 0, "");
    let constants = generated_constants();
    assert_link_matches_source(&constants);
    for (name, value) in &constants {
        println!("{}={}", name, value);
    }
}

// --- Entry ----------------------------------------------------------------------

const USAGE: &str = "usage: t27core <capacity|review|retry|merge|counts|constants> [args...]";

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let (command, args) = match argv.split_first() {
        Some(split) => split,
        None => refuse(format!("no subcommand given - {}", USAGE)),
    };

    match command.as_str() {
        "capacity" => run_capacity(args),
        "review" => run_review(args),
        "retry" => run_retry(args),
        "merge" => run_merge(args),
        "counts" => run_counts(args),
        "constants" => run_constants(args),
        other => refuse(format!("unknown subcommand '{}' - {}", other, USAGE)),
    }
}
