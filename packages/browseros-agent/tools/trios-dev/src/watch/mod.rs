//! Watch mode — dev environment with HMR + browser + server

mod builder;
mod cdp;
mod orchestrator;

#[allow(unused_imports)]
pub use builder::build_agent;
#[allow(unused_imports)]
pub use cdp::wait_for_cdp_ready;
pub use orchestrator::{run_watch, run_test};
