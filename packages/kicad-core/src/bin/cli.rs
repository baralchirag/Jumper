//! `kicad-core` command line, used by workers and for debugging.
//!
//!   kicad-core parse <file>
//!   kicad-core diff <before|-> <after|->
//!   kicad-core conflicts <base> <ours> <theirs>
//!   kicad-core bom <sheet.kicad_sch>...

use std::process::ExitCode;

fn read(path: &str) -> Result<String, String> {
    if path == "-" {
        return Ok(String::new());
    }
    std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))
}

fn run(args: &[String]) -> Result<String, String> {
    let cmd = args.first().map(String::as_str).unwrap_or("");
    let files: Vec<String> = args.iter().skip(1).map(|p| read(p)).collect::<Result<_, _>>()?;
    let refs: Vec<&str> = files.iter().map(String::as_str).collect();
    match (cmd, refs.as_slice()) {
        ("parse", [f]) => kicad_core::parse_json(f, "auto"),
        ("diff", [a, b]) => kicad_core::diff_json(a, b, "auto"),
        ("conflicts", [base, ours, theirs]) => kicad_core::conflicts_json(base, ours, theirs, "auto"),
        ("bom", sheets) if !sheets.is_empty() => kicad_core::bom_json(sheets),
        _ => Err("usage: kicad-core <parse FILE | diff A B | conflicts BASE OURS THEIRS | bom SHEET...>".into()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(out) => {
            println!("{out}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
