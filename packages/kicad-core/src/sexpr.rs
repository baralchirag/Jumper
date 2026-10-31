//! Minimal, defensive S-expression parser for KiCad files.
//!
//! Inputs are untrusted (user pushes), so the parser enforces a nesting
//! limit and never recurses on the call stack.

use std::fmt;

pub const MAX_DEPTH: usize = 1024;
pub const MAX_INPUT_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum Sexp {
    List(Vec<Sexp>),
    /// Bare token, e.g. `footprint`, `1.27`, `yes`.
    Atom(String),
    /// Quoted string with escapes resolved.
    Str(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParseError {
    pub message: String,
    pub offset: usize,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at byte {}", self.message, self.offset)
    }
}

impl std::error::Error for ParseError {}

fn err(message: impl Into<String>, offset: usize) -> ParseError {
    ParseError { message: message.into(), offset }
}

/// Parse the first top-level expression in `input`.
pub fn parse(input: &str) -> Result<Sexp, ParseError> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(err("input too large", 0));
    }
    let bytes = input.as_bytes();
    let mut stack: Vec<Vec<Sexp>> = Vec::new();
    let mut i = 0usize;

    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b'(' => {
                if stack.len() >= MAX_DEPTH {
                    return Err(err("nesting too deep", i));
                }
                stack.push(Vec::new());
                i += 1;
            }
            b')' => {
                let done = stack.pop().ok_or_else(|| err("unexpected ')'", i))?;
                let node = Sexp::List(done);
                i += 1;
                match stack.last_mut() {
                    Some(parent) => parent.push(node),
                    None => return Ok(node),
                }
            }
            b'"' => {
                let start = i;
                i += 1;
                let mut buf: Vec<u8> = Vec::new();
                loop {
                    if i >= bytes.len() {
                        return Err(err("unterminated string", start));
                    }
                    match bytes[i] {
                        b'"' => {
                            i += 1;
                            break;
                        }
                        b'\\' if i + 1 < bytes.len() => {
                            let e = bytes[i + 1];
                            buf.push(match e {
                                b'n' => b'\n',
                                b't' => b'\t',
                                b'r' => b'\r',
                                other => other,
                            });
                            i += 2;
                        }
                        b => {
                            buf.push(b);
                            i += 1;
                        }
                    }
                }
                let s = String::from_utf8_lossy(&buf).into_owned();
                push_leaf(&mut stack, Sexp::Str(s), start)?;
            }
            b' ' | b'\t' | b'\n' | b'\r' => i += 1,
            _ => {
                let start = i;
                while i < bytes.len() && !matches!(bytes[i], b'(' | b')' | b' ' | b'\t' | b'\n' | b'\r' | b'"') {
                    i += 1;
                }
                let s = String::from_utf8_lossy(&bytes[start..i]).into_owned();
                push_leaf(&mut stack, Sexp::Atom(s), start)?;
            }
        }
    }
    if stack.is_empty() {
        Err(err("empty input", 0))
    } else {
        Err(err("unexpected end of input", bytes.len()))
    }
}

fn push_leaf(stack: &mut [Vec<Sexp>], node: Sexp, offset: usize) -> Result<(), ParseError> {
    match stack.last_mut() {
        Some(parent) => {
            parent.push(node);
            Ok(())
        }
        None => Err(err("expected '(' at top level", offset)),
    }
}

impl Sexp {
    pub fn items(&self) -> &[Sexp] {
        match self {
            Sexp::List(v) => v,
            _ => &[],
        }
    }

    /// The leading token of a list, e.g. `footprint` for `(footprint ...)`.
    pub fn head(&self) -> Option<&str> {
        match self.items().first() {
            Some(Sexp::Atom(s)) => Some(s),
            _ => None,
        }
    }

    pub fn is(&self, name: &str) -> bool {
        self.head() == Some(name)
    }

    /// String value of a leaf (atom or quoted).
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Sexp::Atom(s) | Sexp::Str(s) => Some(s),
            Sexp::List(_) => None,
        }
    }

    /// String value of the n-th item of a list (0 is the head).
    pub fn str_at(&self, n: usize) -> Option<&str> {
        self.items().get(n).and_then(Sexp::as_str)
    }

    pub fn f64_at(&self, n: usize) -> Option<f64> {
        self.str_at(n).and_then(|s| s.parse::<f64>().ok())
    }

    /// Child lists (skipping the head).
    pub fn lists(&self) -> impl Iterator<Item = &Sexp> {
        self.items().iter().skip(1).filter(|s| matches!(s, Sexp::List(_)))
    }

    pub fn find(&self, name: &str) -> Option<&Sexp> {
        self.lists().find(|s| s.is(name))
    }

    pub fn find_all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Sexp> + 'a {
        self.lists().filter(move |s| s.is(name))
    }

    /// First value of a child list: `(name value)` -> value.
    pub fn value_of(&self, name: &str) -> Option<&str> {
        self.find(name).and_then(|s| s.str_at(1))
    }

    pub fn f64_of(&self, name: &str) -> Option<f64> {
        self.find(name).and_then(|s| s.f64_at(1))
    }

    /// True when a bare atom (not head) is present, e.g. `hide` in `(pin ... hide)`.
    pub fn has_atom(&self, atom: &str) -> bool {
        self.items().iter().skip(1).any(|s| matches!(s, Sexp::Atom(a) if a == atom))
    }

    /// `(name yes)` / `(name)` / bare `name` flags as used across KiCad versions.
    pub fn flag(&self, name: &str) -> bool {
        if self.has_atom(name) {
            return true;
        }
        match self.find(name) {
            Some(node) => !matches!(node.str_at(1), Some("no") | Some("false")),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_lists_and_strings() {
        let s = parse(r#"(a (b 1 2) "x \"y\"" (c))"#).unwrap();
        assert_eq!(s.head(), Some("a"));
        assert_eq!(s.find("b").unwrap().f64_at(2), Some(2.0));
        assert_eq!(s.str_at(2), Some("x \"y\""));
        assert!(s.find("c").is_some());
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse("").is_err());
        assert!(parse("(a").is_err());
        assert!(parse(")").is_err());
        assert!(parse("atom").is_err());
    }

    #[test]
    fn enforces_depth_limit() {
        let deep = "(".repeat(MAX_DEPTH + 1);
        assert_eq!(parse(&deep).unwrap_err().message, "nesting too deep");
    }

    #[test]
    fn flags() {
        let s = parse("(pin (hide yes) dnp (exclude_from_sim no))").unwrap();
        assert!(s.flag("hide"));
        assert!(s.flag("dnp"));
        assert!(!s.flag("exclude_from_sim"));
        assert!(!s.flag("missing"));
    }
}
