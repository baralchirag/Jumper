//! Jumper KiCad core: parsing, semantic diff and BOM for KiCad 6+ files.
//!
//! The same code is compiled natively (CLI used by workers) and to
//! WebAssembly (browser viewer and Node API).

pub mod bom;
pub mod diff;
pub mod geom;
pub mod pcb;
pub mod sch;
pub mod sexpr;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Pcb,
    Schematic,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "pcb" | "kicad_pcb" => Some(Kind::Pcb),
            "sch" | "schematic" | "kicad_sch" => Some(Kind::Schematic),
            _ => None,
        }
    }
}

/// Sniff the file kind from its first token.
pub fn detect_kind(text: &str) -> Option<Kind> {
    let head = text.trim_start().strip_prefix('(')?.trim_start();
    if head.starts_with("kicad_pcb") {
        Some(Kind::Pcb)
    } else if head.starts_with("kicad_sch") {
        Some(Kind::Schematic)
    } else {
        None
    }
}

fn resolve_kind(kind: &str, texts: &[&str]) -> Result<Kind, String> {
    if let Some(k) = Kind::parse(kind) {
        return Ok(k);
    }
    texts
        .iter()
        .filter(|t| !t.trim().is_empty())
        .find_map(|t| detect_kind(t))
        .ok_or_else(|| "unable to detect KiCad file kind".to_string())
}

fn to_json<T: Serialize>(v: &T) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}

fn pcb_or_empty(text: &str) -> Result<pcb::Pcb, String> {
    if text.trim().is_empty() {
        Ok(pcb::Pcb::default())
    } else {
        pcb::parse_pcb(text)
    }
}

fn sch_or_empty(text: &str) -> Result<sch::Schematic, String> {
    if text.trim().is_empty() {
        Ok(sch::Schematic::default())
    } else {
        sch::parse_schematic(text)
    }
}

/// Parse to the typed model as JSON: `{"kind": "...", "model": {...}}`.
pub fn parse_json(text: &str, kind: &str) -> Result<String, String> {
    match resolve_kind(kind, &[text])? {
        Kind::Pcb => to_json(&serde_json::json!({"kind": "pcb", "model": pcb::parse_pcb(text)?})),
        Kind::Schematic => to_json(&serde_json::json!({"kind": "schematic", "model": sch::parse_schematic(text)?})),
    }
}

pub fn diff_result(before: &str, after: &str, kind: &str) -> Result<diff::DiffResult, String> {
    Ok(match resolve_kind(kind, &[before, after])? {
        Kind::Pcb => diff::diff_pcb(&pcb_or_empty(before)?, &pcb_or_empty(after)?),
        Kind::Schematic => diff::diff_schematic(&sch_or_empty(before)?, &sch_or_empty(after)?),
    })
}

/// Semantic diff between two revisions; an empty string means "file absent".
pub fn diff_json(before: &str, after: &str, kind: &str) -> Result<String, String> {
    to_json(&diff_result(before, after, kind)?)
}

pub fn conflicts_json(base: &str, ours: &str, theirs: &str, kind: &str) -> Result<String, String> {
    let k = match resolve_kind(kind, &[base, ours, theirs])? {
        Kind::Pcb => "pcb",
        Kind::Schematic => "sch",
    };
    let a = diff_result(base, ours, k)?;
    let b = diff_result(base, theirs, k)?;
    to_json(&diff::conflicts(&a, &b))
}

pub fn bom_lines(sheets: &[&str]) -> Result<Vec<bom::BomLine>, String> {
    let parsed = sheets.iter().filter(|s| !s.trim().is_empty()).map(|s| sch::parse_schematic(s)).collect::<Result<Vec<_>, _>>()?;
    Ok(bom::bom(&parsed))
}

pub fn bom_json(sheets: &[&str]) -> Result<String, String> {
    to_json(&bom_lines(sheets)?)
}

pub fn bom_diff_json(before: &[&str], after: &[&str]) -> Result<String, String> {
    to_json(&bom::bom_diff(&bom_lines(before)?, &bom_lines(after)?))
}

#[cfg(feature = "wasm")]
mod wasm {
    use wasm_bindgen::prelude::*;

    fn js_err(e: String) -> JsValue {
        JsValue::from_str(&e)
    }

    fn sheets(json: &str) -> Result<Vec<String>, JsValue> {
        serde_json::from_str::<Vec<String>>(json).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = detectKind)]
    pub fn detect_kind(text: &str) -> Option<String> {
        super::detect_kind(text).map(|k| match k {
            super::Kind::Pcb => "pcb".to_string(),
            super::Kind::Schematic => "schematic".to_string(),
        })
    }

    /// Returns `{"kind": "pcb"|"schematic", "model": {...}}` as JSON.
    #[wasm_bindgen]
    pub fn parse(text: &str, kind: &str) -> Result<String, JsValue> {
        super::parse_json(text, kind).map_err(js_err)
    }

    #[wasm_bindgen]
    pub fn diff(before: &str, after: &str, kind: &str) -> Result<String, JsValue> {
        super::diff_json(before, after, kind).map_err(js_err)
    }

    #[wasm_bindgen]
    pub fn conflicts(base: &str, ours: &str, theirs: &str, kind: &str) -> Result<String, JsValue> {
        super::conflicts_json(base, ours, theirs, kind).map_err(js_err)
    }

    /// `sheets_json` is a JSON array of schematic file contents.
    #[wasm_bindgen]
    pub fn bom(sheets_json: &str) -> Result<String, JsValue> {
        let s = sheets(sheets_json)?;
        super::bom_json(&s.iter().map(String::as_str).collect::<Vec<_>>()).map_err(js_err)
    }

    #[wasm_bindgen(js_name = bomDiff)]
    pub fn bom_diff(before_json: &str, after_json: &str) -> Result<String, JsValue> {
        let (a, b) = (sheets(before_json)?, sheets(after_json)?);
        super::bom_diff_json(&a.iter().map(String::as_str).collect::<Vec<_>>(), &b.iter().map(String::as_str).collect::<Vec<_>>()).map_err(js_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_kinds() {
        assert_eq!(detect_kind("  (kicad_pcb (version 1))"), Some(Kind::Pcb));
        assert_eq!(detect_kind("(kicad_sch"), Some(Kind::Schematic));
        assert_eq!(detect_kind("hello"), None);
    }

    #[test]
    fn diff_against_absent_file() {
        let d = diff_result("", "(kicad_pcb (net 0 \"\") (net 1 \"VCC\"))", "auto").unwrap();
        assert_eq!(d.summary.added, 1);
    }
}
