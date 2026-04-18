use colored::Colorize;

pub fn tag_line(tag: &str, color_fn: fn(&str) -> colored::ColoredString, msg: &str) {
    println!("{} {}", color_fn(&format!("[{}]", tag)), msg);
}

pub fn info(tag: &str, msg: &str) {
    tag_line(tag, |s| s.green(), msg);
}

pub fn server(msg: &str) {
    tag_line("server", |s| s.cyan(), msg);
}

pub fn agent(msg: &str) {
    tag_line("agent", |s| s.magenta(), msg);
}

pub fn browser(msg: &str) {
    tag_line("browser", |s| s.blue(), msg);
}

pub fn warn(tag: &str, msg: &str) {
    tag_line(tag, |s| s.yellow(), msg);
}

pub fn error(tag: &str, msg: &str) {
    tag_line(tag, |s| s.red(), msg);
}

pub fn build(msg: &str) {
    tag_line("build", |s| s.yellow(), msg);
}

pub fn test_log(msg: &str) {
    tag_line("test", |s| s.white(), msg);
}
