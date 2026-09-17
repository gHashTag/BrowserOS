// Differential harness: prints every verdict the generated ring produces for a
// fixed grid of inputs. Its Swift twin prints the same grid from the
// hand-written policy, and the two outputs must be byte-identical.
mod core;
fn main() {
    for a in 0..5 {
        println!("retry {} -> {}", a, core::retry_verdict(a));
    }
    for k in 0..3 {
        println!("counts {} -> {}", k, core::counts_against_issue(k));
    }
    for total in [0, 1, 3] {
        for judged in [0, 1, 3] {
            for unmet in [0, 1] {
                for files in [0, 2] {
                    for sb in [0, 2] {
                        println!(
                            "review {} {} {} {} {} -> {}",
                            total, judged, unmet, files, sb,
                            core::review_verdict(total, judged, unmet, files, sb)
                        );
                    }
                }
            }
        }
    }
}
