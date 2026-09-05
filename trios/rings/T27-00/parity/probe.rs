// The generated ring, made answerable, so a harness can put the same question
// to it and to the hand-written twin.
//
// THIS FILE IS NOT A RULE AND MUST NEVER BECOME ONE. It is stdin, stdout and a
// match on a verb. Every decision below is a call into `queen_core.rs`, which
// is generated from `rings/T27-00/queen_core.t27` and never edited. If a rule
// appears here, this file has become the fifth copy of the law and the whole
// exercise has inverted.
//
// `include!` rather than a module import, deliberately: the artifact stays a
// byte-identical file that `t27c` can rewrite at any moment without this file
// needing to know how it is laid out. `cargo` is not involved for the same
// reason - the ring compiles under bare `rustc --crate-type lib`, which is the
// property that lets it be checked anywhere, including in a container that has
// no Rust toolchain manager.
//
// Protocol: one question per line on stdin, one answer per line on stdout.
//
//   retry <real_attempts>                    -> attempt | escalate
//   counts <kind>                            -> true | false
//   review <total> <judged> <unmet> <files> <prior>
//                                            -> wait | accept | sendBack | escalate
//   capacity <running>                       -> true | false
//   slots <running>                          -> <integer>
//
// The words on the right are the twin's vocabulary, not the ring's. The ring
// speaks integers; translating them here rather than in the harness keeps the
// coding table in one place - the same reason the spec says its verdicts are
// constants and not scattered literals.

include!("../generated/queen_core.rs");

use std::io::{self, BufRead, Write};

fn retry_word(v: i32) -> &'static str {
    if v == RETRY_ESCALATE { "escalate" } else { "attempt" }
}

fn review_word(v: i32) -> &'static str {
    if v == REVIEW_ACCEPT {
        "accept"
    } else if v == REVIEW_SEND_BACK {
        "sendBack"
    } else if v == REVIEW_ESCALATE {
        "escalate"
    } else {
        "wait"
    }
}

fn num(parts: &[&str], i: usize) -> i32 {
    parts.get(i).and_then(|s| s.parse::<i32>().ok()).unwrap_or(0)
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }
        let answer = match parts[0] {
            "retry" => retry_word(retry_verdict(num(&parts, 1))).to_string(),
            "counts" => counts_against_issue(num(&parts, 1)).to_string(),
            "review" => review_word(review_verdict(
                num(&parts, 1),
                num(&parts, 2),
                num(&parts, 3),
                num(&parts, 4),
                num(&parts, 5),
            ))
            .to_string(),
            "capacity" => can_start_another(num(&parts, 1)).to_string(),
            "slots" => free_slots(num(&parts, 1)).to_string(),
            // An unknown verb is an error, never a default answer. A probe that
            // guesses turns a harness disagreement into a harness agreement.
            other => format!("ERROR unknown question `{}`", other),
        };
        let _ = writeln!(out, "{}", answer);
    }
}
