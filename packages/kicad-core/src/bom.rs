//! Bill of materials grouped from schematic symbols, plus BOM diffing.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::sch::Schematic;

/// Symbol fields copied into BOM lines when present.
const EXTRA_FIELDS: &[&str] = &["MPN", "Manufacturer", "Manufacturer_Part_Number", "LCSC", "Supplier", "Supplier_PN", "Description"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BomLine {
    pub references: Vec<String>,
    pub quantity: usize,
    pub value: String,
    pub footprint: String,
    pub lib_id: String,
    pub dnp: bool,
    pub fields: BTreeMap<String, String>,
}

impl BomLine {
    pub fn key(&self) -> String {
        let mpn = self.fields.get("MPN").or_else(|| self.fields.get("Manufacturer_Part_Number")).map(String::as_str).unwrap_or("");
        format!("{}|{}|{}|{}", self.value, self.footprint, mpn, self.dnp)
    }
}

/// Split "R12" into ("R", 12) so R2 sorts before R10.
fn ref_sort_key(r: &str) -> (String, u64, String) {
    let idx = r.find(|c: char| c.is_ascii_digit()).unwrap_or(r.len());
    let (prefix, rest) = r.split_at(idx);
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    let tail = rest[digits.len()..].to_string();
    (prefix.to_string(), digits.parse().unwrap_or(0), tail)
}

pub fn bom(sheets: &[Schematic]) -> Vec<BomLine> {
    let mut groups: BTreeMap<String, BomLine> = BTreeMap::new();
    let mut seen_refs: BTreeSet<String> = BTreeSet::new();
    for sch in sheets {
        for s in &sch.symbols {
            if s.reference.is_empty() || s.reference.starts_with('#') || !s.in_bom {
                continue;
            }
            if sch.lib_symbol(s).map(|l| l.power).unwrap_or(false) {
                continue;
            }
            // Multi-unit parts appear once per unit; count the part once.
            if !seen_refs.insert(s.reference.clone()) {
                continue;
            }
            let fields: BTreeMap<String, String> = s
                .properties
                .iter()
                .filter(|p| EXTRA_FIELDS.contains(&p.key.as_str()) && !p.value.is_empty() && p.value != "~")
                .map(|p| (p.key.clone(), p.value.clone()))
                .collect();
            let line = BomLine {
                references: vec![s.reference.clone()],
                quantity: 1,
                value: s.value.clone(),
                footprint: s.footprint.clone(),
                lib_id: s.lib_id.clone(),
                dnp: s.dnp,
                fields,
            };
            groups
                .entry(line.key())
                .and_modify(|g| {
                    g.references.push(s.reference.clone());
                    g.quantity += 1;
                })
                .or_insert(line);
        }
    }
    let mut lines: Vec<BomLine> = groups.into_values().collect();
    for l in &mut lines {
        l.references.sort_by_key(|r| ref_sort_key(r));
    }
    lines.sort_by(|a, b| {
        let ka = a.references.first().map(|r| ref_sort_key(r)).unwrap_or_default();
        let kb = b.references.first().map(|r| ref_sort_key(r)).unwrap_or_default();
        ka.cmp(&kb)
    });
    lines
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BomChange {
    pub op: crate::diff::Op,
    pub value: String,
    pub footprint: String,
    pub quantity_before: usize,
    pub quantity_after: usize,
    pub references_added: Vec<String>,
    pub references_removed: Vec<String>,
}

pub fn bom_diff(a: &[BomLine], b: &[BomLine]) -> Vec<BomChange> {
    use crate::diff::Op;
    let ma: BTreeMap<String, &BomLine> = a.iter().map(|l| (l.key(), l)).collect();
    let mb: BTreeMap<String, &BomLine> = b.iter().map(|l| (l.key(), l)).collect();
    let keys: BTreeSet<&String> = ma.keys().chain(mb.keys()).collect();
    let mut out = Vec::new();
    for k in keys {
        let (x, y) = (ma.get(k), mb.get(k));
        let refs = |l: Option<&&BomLine>| l.map(|l| l.references.iter().cloned().collect::<BTreeSet<_>>()).unwrap_or_default();
        let (ra, rb) = (refs(x), refs(y));
        if ra == rb {
            continue;
        }
        let line = y.or(x).unwrap();
        out.push(BomChange {
            op: match (x, y) {
                (None, _) => Op::Added,
                (_, None) => Op::Removed,
                _ => Op::Modified,
            },
            value: line.value.clone(),
            footprint: line.footprint.clone(),
            quantity_before: ra.len(),
            quantity_after: rb.len(),
            references_added: rb.difference(&ra).cloned().collect(),
            references_removed: ra.difference(&rb).cloned().collect(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_reference_order() {
        let mut v = vec!["R10", "R2", "C1", "R1"];
        v.sort_by_key(|r| ref_sort_key(r));
        assert_eq!(v, vec!["C1", "R1", "R2", "R10"]);
    }
}
