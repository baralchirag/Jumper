//! Semantic diff of KiCad designs.
//!
//! Every design object is flattened into a [`Record`] (stable id + comparable
//! fields). Records are matched by KiCad UUID first and by a human key (e.g.
//! the reference designator) second, so re-annotated or re-imported parts are
//! still matched where possible.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::geom::{round6, BBox, Pt};
use crate::pcb::{shape_bbox, Pcb, Shape};
use crate::sch::{SchShape, Schematic};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    Added,
    Removed,
    Modified,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldChange {
    pub field: String,
    pub before: Option<Value>,
    pub after: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub op: Op,
    pub object: String,
    pub id: String,
    pub label: String,
    pub layer: Option<String>,
    pub bbox: Option<BBox>,
    pub fields: Vec<FieldChange>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub added: usize,
    pub removed: usize,
    pub modified: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub added: usize,
    pub removed: usize,
    pub modified: usize,
    pub by_object: BTreeMap<String, Counts>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetChange {
    pub name: String,
    pub op: Op,
    pub tracks_before: usize,
    pub tracks_after: usize,
    pub vias_before: usize,
    pub vias_after: usize,
    pub length_before: f64,
    pub length_after: f64,
    pub pads_before: Vec<String>,
    pub pads_after: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub kind: String,
    pub summary: Summary,
    pub changes: Vec<Change>,
    pub nets: Vec<NetChange>,
}

#[derive(Debug, Clone)]
pub struct Record {
    pub object: &'static str,
    pub id: String,
    pub alt_key: Option<String>,
    pub label: String,
    pub layer: Option<String>,
    pub bbox: Option<BBox>,
    pub fields: BTreeMap<String, Value>,
}

fn n(v: f64) -> Value {
    json!(round6(v))
}

fn p(pt: &Pt) -> Value {
    json!([round6(pt.x), round6(pt.y)])
}

fn pts(v: &[Pt]) -> Value {
    Value::Array(v.iter().map(p).collect())
}

fn bbox_of_pts<'a>(pts: impl IntoIterator<Item = &'a Pt>, pad: f64) -> Option<BBox> {
    let mut b = BBox::empty();
    for pt in pts {
        b.add_pt(pt);
    }
    b.inflate(pad).option()
}

/// Stable id for objects without a UUID: hash of their fields.
fn content_id(object: &str, fields: &BTreeMap<String, Value>) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    object.hash(&mut h);
    serde_json::to_string(fields).unwrap_or_default().hash(&mut h);
    format!("~{:016x}", h.finish())
}

fn shape_value(shape: &Shape) -> Value {
    serde_json::to_value(shape).unwrap_or(Value::Null)
}

fn shape_name(shape: &Shape) -> &'static str {
    match shape {
        Shape::Line { .. } => "Line",
        Shape::Arc { .. } => "Arc",
        Shape::Circle { .. } => "Circle",
        Shape::Rect { .. } => "Rectangle",
        Shape::Poly { .. } => "Polygon",
        Shape::Curve { .. } => "Curve",
    }
}

pub fn pcb_records(pcb: &Pcb) -> Vec<Record> {
    let mut out = Vec::new();
    let net = |id: u32| pcb.net_name(id).to_string();

    for net in &pcb.nets {
        if net.name.is_empty() {
            continue;
        }
        out.push(Record {
            object: "net",
            id: format!("net:{}", net.name),
            alt_key: None,
            label: net.name.clone(),
            layer: None,
            bbox: None,
            fields: BTreeMap::new(),
        });
    }

    for fp in &pcb.footprints {
        let mut f = BTreeMap::new();
        f.insert("reference".into(), json!(fp.reference));
        f.insert("value".into(), json!(fp.value));
        f.insert("libId".into(), json!(fp.lib_id));
        f.insert("layer".into(), json!(fp.layer));
        f.insert("position".into(), p(&fp.at));
        f.insert("rotation".into(), n(fp.rotation));
        f.insert("locked".into(), json!(fp.locked));
        f.insert("attributes".into(), json!(fp.attrs));
        f.insert("models".into(), json!(fp.models));
        for (k, v) in &fp.properties {
            if k != "Reference" && k != "Value" {
                f.insert(format!("property.{k}"), json!(v));
            }
        }
        for pad in &fp.pads {
            if !pad.number.is_empty() {
                f.insert(format!("pad.{}.net", pad.number), json!(pad.net_name));
            }
        }
        let label = if fp.reference.is_empty() { fp.lib_id.clone() } else { format!("{} ({})", fp.reference, fp.value) };
        out.push(Record {
            object: "footprint",
            id: fp.uuid.clone(),
            alt_key: (!fp.reference.is_empty() && !fp.reference.ends_with('?')).then(|| fp.reference.clone()),
            label,
            layer: Some(fp.layer.clone()),
            bbox: fp.bbox,
            fields: f,
        });
    }

    for t in &pcb.tracks {
        let mut f = BTreeMap::new();
        f.insert("start".into(), p(&t.start));
        f.insert("end".into(), p(&t.end));
        if let Some(m) = &t.mid {
            f.insert("mid".into(), p(m));
        }
        f.insert("width".into(), n(t.width));
        f.insert("layer".into(), json!(t.layer));
        f.insert("net".into(), json!(net(t.net)));
        let mut pts_v = vec![t.start, t.end];
        if let Some(m) = t.mid {
            pts_v.push(m);
        }
        let id = if t.uuid.is_empty() { content_id("track", &f) } else { t.uuid.clone() };
        out.push(Record {
            object: "track",
            id,
            alt_key: None,
            label: format!("Track {} on {}", display_net(&net(t.net)), t.layer),
            layer: Some(t.layer.clone()),
            bbox: bbox_of_pts(&pts_v, t.width / 2.0),
            fields: f,
        });
    }

    for v in &pcb.vias {
        let mut f = BTreeMap::new();
        f.insert("position".into(), p(&v.at));
        f.insert("size".into(), n(v.size));
        f.insert("drill".into(), n(v.drill));
        f.insert("layers".into(), json!(v.layers));
        f.insert("net".into(), json!(net(v.net)));
        f.insert("type".into(), json!(v.via_type));
        let id = if v.uuid.is_empty() { content_id("via", &f) } else { v.uuid.clone() };
        let mut b = BBox::empty();
        b.add_circle(&v.at, v.size / 2.0);
        out.push(Record {
            object: "via",
            id,
            alt_key: None,
            label: format!("Via {}", display_net(&net(v.net))),
            layer: None,
            bbox: b.option(),
            fields: f,
        });
    }

    for z in &pcb.zones {
        let mut f = BTreeMap::new();
        f.insert("net".into(), json!(z.net_name));
        f.insert("layers".into(), json!(z.layers));
        f.insert("priority".into(), json!(z.priority));
        f.insert("keepout".into(), json!(z.keepout));
        f.insert("outline".into(), pts(&z.outline));
        if let Some(name) = &z.name {
            f.insert("name".into(), json!(name));
        }
        let id = if z.uuid.is_empty() { content_id("zone", &f) } else { z.uuid.clone() };
        let kind = if z.keepout { "Keepout" } else { "Zone" };
        out.push(Record {
            object: "zone",
            id,
            alt_key: None,
            label: format!("{kind} {} on {}", display_net(&z.net_name), z.layers.join(", ")),
            layer: z.layers.first().cloned(),
            bbox: bbox_of_pts(&z.outline, 0.0),
            fields: f,
        });
    }

    for g in &pcb.graphics {
        let mut f = BTreeMap::new();
        f.insert("shape".into(), shape_value(&g.shape));
        f.insert("width".into(), n(g.width));
        f.insert("layer".into(), json!(g.layer));
        f.insert("fill".into(), json!(g.fill));
        let id = g.uuid.clone().unwrap_or_else(|| content_id("graphic", &f));
        out.push(Record {
            object: "graphic",
            id,
            alt_key: None,
            label: format!("{} on {}", shape_name(&g.shape), g.layer),
            layer: Some(g.layer.clone()),
            bbox: shape_bbox(&g.shape, g.width).option(),
            fields: f,
        });
    }

    for t in &pcb.texts {
        let mut f = BTreeMap::new();
        f.insert("text".into(), json!(t.text));
        f.insert("position".into(), p(&t.at));
        f.insert("rotation".into(), n(t.rotation));
        f.insert("layer".into(), json!(t.layer));
        let id = t.uuid.clone().unwrap_or_else(|| content_id("text", &f));
        out.push(Record {
            object: "text",
            id,
            alt_key: None,
            label: format!("Text \"{}\"", truncate(&t.text, 40)),
            layer: Some(t.layer.clone()),
            bbox: bbox_of_pts([&t.at], t.size.y.max(1.0)),
            fields: f,
        });
    }
    out
}

pub fn sch_records(sch: &Schematic) -> Vec<Record> {
    let mut out = Vec::new();

    for s in &sch.symbols {
        let mut f = BTreeMap::new();
        f.insert("reference".into(), json!(s.reference));
        f.insert("value".into(), json!(s.value));
        f.insert("footprint".into(), json!(s.footprint));
        f.insert("libId".into(), json!(s.lib_id));
        f.insert("position".into(), p(&s.at));
        f.insert("rotation".into(), n(s.rotation));
        f.insert("mirror".into(), json!(s.mirror));
        f.insert("unit".into(), json!(s.unit));
        f.insert("dnp".into(), json!(s.dnp));
        f.insert("inBom".into(), json!(s.in_bom));
        f.insert("onBoard".into(), json!(s.on_board));
        for prop in &s.properties {
            if !matches!(prop.key.as_str(), "Reference" | "Value" | "Footprint") {
                f.insert(format!("property.{}", prop.key), json!(prop.value));
            }
        }
        let power = s.reference.starts_with('#');
        let label = if power { format!("Power {}", s.value) } else { format!("{} ({})", s.reference, s.value) };
        out.push(Record {
            object: "symbol",
            id: s.uuid.clone(),
            alt_key: (!power && !s.reference.ends_with('?')).then(|| format!("{}#{}", s.reference, s.unit)),
            label,
            layer: None,
            bbox: bbox_of_pts([&s.at], 5.08),
            fields: f,
        });
    }

    for w in &sch.wires {
        let mut f = BTreeMap::new();
        f.insert("points".into(), pts(&w.pts));
        let id = if w.uuid.is_empty() { content_id(&w.kind, &f) } else { w.uuid.clone() };
        out.push(Record {
            object: if w.kind == "bus" { "bus" } else { "wire" },
            id,
            alt_key: None,
            label: if w.kind == "bus" { "Bus".into() } else { "Wire".into() },
            layer: None,
            bbox: bbox_of_pts(&w.pts, 0.5),
            fields: f,
        });
    }

    for j in &sch.junctions {
        let mut f = BTreeMap::new();
        f.insert("position".into(), p(&j.at));
        let id = if j.uuid.is_empty() { content_id("junction", &f) } else { j.uuid.clone() };
        out.push(Record { object: "junction", id, alt_key: None, label: "Junction".into(), layer: None, bbox: bbox_of_pts([&j.at], 1.0), fields: f });
    }

    for nc in &sch.no_connects {
        let mut f = BTreeMap::new();
        f.insert("position".into(), p(&nc.at));
        let id = if nc.uuid.is_empty() { content_id("noConnect", &f) } else { nc.uuid.clone() };
        out.push(Record { object: "noConnect", id, alt_key: None, label: "No-connect".into(), layer: None, bbox: bbox_of_pts([&nc.at], 1.0), fields: f });
    }

    for l in &sch.labels {
        let mut f = BTreeMap::new();
        f.insert("text".into(), json!(l.text));
        f.insert("kind".into(), json!(l.kind));
        f.insert("position".into(), p(&l.at));
        f.insert("rotation".into(), n(l.rotation));
        f.insert("shape".into(), json!(l.shape));
        let id = if l.uuid.is_empty() { content_id("label", &f) } else { l.uuid.clone() };
        let kind = match l.kind.as_str() {
            "global" => "Global label",
            "hierarchical" => "Hierarchical label",
            "netclass" => "Net class flag",
            _ => "Label",
        };
        out.push(Record {
            object: "label",
            id,
            alt_key: None,
            label: format!("{kind} \"{}\"", l.text),
            layer: None,
            bbox: bbox_of_pts([&l.at], 2.54),
            fields: f,
        });
    }

    for s in &sch.sheets {
        let mut f = BTreeMap::new();
        f.insert("name".into(), json!(s.name));
        f.insert("file".into(), json!(s.file));
        f.insert("position".into(), p(&s.at));
        f.insert("size".into(), p(&s.size));
        let mut pins: Vec<&str> = s.pins.iter().map(|p| p.name.as_str()).collect();
        pins.sort_unstable();
        f.insert("pins".into(), json!(pins));
        out.push(Record {
            object: "sheet",
            id: s.uuid.clone(),
            alt_key: Some(s.file.clone()),
            label: format!("Sheet \"{}\"", s.name),
            layer: None,
            bbox: bbox_of_pts([&s.at, &s.at.add(&s.size)], 0.0),
            fields: f,
        });
    }

    for t in &sch.texts {
        let mut f = BTreeMap::new();
        f.insert("text".into(), json!(t.text));
        f.insert("position".into(), p(&t.at));
        let id = t.uuid.clone().unwrap_or_else(|| content_id("text", &f));
        out.push(Record {
            object: "text",
            id,
            alt_key: None,
            label: format!("Text \"{}\"", truncate(&t.text, 40)),
            layer: None,
            bbox: bbox_of_pts([&t.at], 2.54),
            fields: f,
        });
    }

    for g in &sch.graphics {
        let mut f = BTreeMap::new();
        f.insert("shape".into(), serde_json::to_value(&g.shape).unwrap_or(Value::Null));
        f.insert("width".into(), n(g.width));
        let id = g.uuid.clone().unwrap_or_else(|| content_id("graphic", &f));
        let pts_v: Vec<Pt> = match &g.shape {
            SchShape::Rect { start, end } => vec![*start, *end],
            SchShape::Circle { center, radius } => vec![Pt::new(center.x - radius, center.y - radius), Pt::new(center.x + radius, center.y + radius)],
            SchShape::Arc { start, mid, end } => vec![*start, *mid, *end],
            SchShape::Polyline { pts } | SchShape::Bezier { pts } => pts.clone(),
            SchShape::Text { at, .. } => vec![*at],
        };
        out.push(Record { object: "graphic", id, alt_key: None, label: "Graphic".into(), layer: None, bbox: bbox_of_pts(&pts_v, 0.5), fields: f });
    }
    out
}

fn display_net(name: &str) -> String {
    if name.is_empty() {
        "(no net)".into()
    } else {
        name.to_string()
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max).collect();
        t.push('…');
        t
    }
}

fn union_bbox(a: Option<BBox>, b: Option<BBox>) -> Option<BBox> {
    match (a, b) {
        (Some(mut x), Some(y)) => {
            x.union(&y);
            Some(x)
        }
        (x, None) => x,
        (None, y) => y,
    }
}

pub fn diff_records(before: Vec<Record>, after: Vec<Record>) -> Vec<Change> {
    let mut changes = Vec::new();

    let key = |r: &Record| format!("{}|{}", r.object, r.id);
    let mut after_by_id: HashMap<String, usize> = HashMap::new();
    for (i, r) in after.iter().enumerate() {
        if !r.id.is_empty() {
            after_by_id.entry(key(r)).or_insert(i);
        }
    }

    let mut matched_after: HashSet<usize> = HashSet::new();
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    let mut unmatched_before: Vec<usize> = Vec::new();

    for (i, r) in before.iter().enumerate() {
        match (!r.id.is_empty()).then(|| after_by_id.get(&key(r))).flatten() {
            Some(&j) if !matched_after.contains(&j) => {
                matched_after.insert(j);
                pairs.push((i, j));
            }
            _ => unmatched_before.push(i),
        }
    }

    // Second pass: match leftovers by human key (reference designator etc.).
    let mut after_by_alt: HashMap<String, usize> = HashMap::new();
    for (j, r) in after.iter().enumerate() {
        if matched_after.contains(&j) {
            continue;
        }
        if let Some(alt) = &r.alt_key {
            after_by_alt.entry(format!("{}|{}", r.object, alt)).or_insert(j);
        }
    }
    let mut removed: Vec<usize> = Vec::new();
    for i in unmatched_before {
        let r = &before[i];
        let alt = r.alt_key.as_ref().map(|a| format!("{}|{}", r.object, a));
        match alt.and_then(|a| after_by_alt.remove(&a)) {
            Some(j) => {
                matched_after.insert(j);
                pairs.push((i, j));
            }
            None => removed.push(i),
        }
    }

    for i in removed {
        let r = &before[i];
        changes.push(Change {
            op: Op::Removed,
            object: r.object.to_string(),
            id: r.id.clone(),
            label: r.label.clone(),
            layer: r.layer.clone(),
            bbox: r.bbox,
            fields: Vec::new(),
        });
    }

    for (i, j) in pairs {
        let (a, b) = (&before[i], &after[j]);
        let mut fields = Vec::new();
        let keys: std::collections::BTreeSet<&String> = a.fields.keys().chain(b.fields.keys()).collect();
        for k in keys {
            let (va, vb) = (a.fields.get(k), b.fields.get(k));
            if va != vb {
                fields.push(FieldChange { field: k.clone(), before: va.cloned(), after: vb.cloned() });
            }
        }
        if !fields.is_empty() {
            changes.push(Change {
                op: Op::Modified,
                object: b.object.to_string(),
                id: b.id.clone(),
                label: b.label.clone(),
                layer: b.layer.clone().or_else(|| a.layer.clone()),
                bbox: union_bbox(a.bbox, b.bbox),
                fields,
            });
        }
    }

    for (j, r) in after.iter().enumerate() {
        if matched_after.contains(&j) {
            continue;
        }
        changes.push(Change {
            op: Op::Added,
            object: r.object.to_string(),
            id: r.id.clone(),
            label: r.label.clone(),
            layer: r.layer.clone(),
            bbox: r.bbox,
            fields: Vec::new(),
        });
    }

    changes.sort_by(|x, y| object_rank(&x.object).cmp(&object_rank(&y.object)).then_with(|| x.label.cmp(&y.label)));
    changes
}

fn object_rank(object: &str) -> u8 {
    match object {
        "footprint" | "symbol" => 0,
        "sheet" => 1,
        "net" | "label" => 2,
        "zone" => 3,
        "track" | "wire" | "bus" => 4,
        "via" | "junction" | "noConnect" => 5,
        _ => 6,
    }
}

fn summarize(changes: &[Change]) -> Summary {
    let mut s = Summary::default();
    for c in changes {
        let entry = s.by_object.entry(c.object.clone()).or_default();
        match c.op {
            Op::Added => {
                s.added += 1;
                entry.added += 1;
            }
            Op::Removed => {
                s.removed += 1;
                entry.removed += 1;
            }
            Op::Modified => {
                s.modified += 1;
                entry.modified += 1;
            }
        }
    }
    s
}

#[derive(Default)]
struct NetStats {
    tracks: usize,
    vias: usize,
    length: f64,
    pads: Vec<String>,
}

fn net_stats(pcb: &Pcb) -> BTreeMap<String, NetStats> {
    let mut m: BTreeMap<String, NetStats> = BTreeMap::new();
    for t in &pcb.tracks {
        let e = m.entry(pcb.net_name(t.net).to_string()).or_default();
        e.tracks += 1;
        e.length += match t.mid {
            Some(mid) => t.start.dist(&mid) + mid.dist(&t.end),
            None => t.start.dist(&t.end),
        };
    }
    for v in &pcb.vias {
        m.entry(pcb.net_name(v.net).to_string()).or_default().vias += 1;
    }
    for fp in &pcb.footprints {
        for pad in &fp.pads {
            if !pad.net_name.is_empty() {
                m.entry(pad.net_name.clone()).or_default().pads.push(format!("{}.{}", fp.reference, pad.number));
            }
        }
    }
    for s in m.values_mut() {
        s.pads.sort();
        s.pads.dedup();
    }
    m.remove("");
    m
}

fn net_changes(a: &Pcb, b: &Pcb) -> Vec<NetChange> {
    let (sa, sb) = (net_stats(a), net_stats(b));
    let names: std::collections::BTreeSet<&String> = sa.keys().chain(sb.keys()).collect();
    let empty = NetStats::default();
    let mut out = Vec::new();
    for name in names {
        let (x, y) = (sa.get(name), sb.get(name));
        let op = match (x, y) {
            (None, Some(_)) => Op::Added,
            (Some(_), None) => Op::Removed,
            _ => Op::Modified,
        };
        let (x, y) = (x.unwrap_or(&empty), y.unwrap_or(&empty));
        let changed = op != Op::Modified
            || x.tracks != y.tracks
            || x.vias != y.vias
            || (x.length - y.length).abs() > 1e-3
            || x.pads != y.pads;
        if changed {
            out.push(NetChange {
                name: name.clone(),
                op,
                tracks_before: x.tracks,
                tracks_after: y.tracks,
                vias_before: x.vias,
                vias_after: y.vias,
                length_before: round6(x.length),
                length_after: round6(y.length),
                pads_before: x.pads.clone(),
                pads_after: y.pads.clone(),
            });
        }
    }
    out
}

pub fn diff_pcb(a: &Pcb, b: &Pcb) -> DiffResult {
    let changes = diff_records(pcb_records(a), pcb_records(b));
    DiffResult { kind: "pcb".into(), summary: summarize(&changes), changes, nets: net_changes(a, b) }
}

pub fn diff_schematic(a: &Schematic, b: &Schematic) -> DiffResult {
    let changes = diff_records(sch_records(a), sch_records(b));
    DiffResult { kind: "schematic".into(), summary: summarize(&changes), changes, nets: Vec::new() }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub object: String,
    pub id: String,
    pub label: String,
    pub bbox: Option<BBox>,
    pub ours: Change,
    pub theirs: Change,
}

/// Objects changed differently on both sides of a three-way merge.
pub fn conflicts(base_to_ours: &DiffResult, base_to_theirs: &DiffResult) -> Vec<Conflict> {
    let theirs: HashMap<(&str, &str), &Change> =
        base_to_theirs.changes.iter().map(|c| ((c.object.as_str(), c.id.as_str()), c)).collect();
    let mut out = Vec::new();
    for o in &base_to_ours.changes {
        let Some(t) = theirs.get(&(o.object.as_str(), o.id.as_str())) else { continue };
        let same = o.op == t.op
            && o.fields.len() == t.fields.len()
            && o.fields.iter().zip(&t.fields).all(|(a, b)| a.field == b.field && a.after == b.after);
        if same {
            continue;
        }
        out.push(Conflict {
            object: o.object.clone(),
            id: o.id.clone(),
            label: o.label.clone(),
            bbox: union_bbox(o.bbox, t.bbox),
            ours: o.clone(),
            theirs: (*t).clone(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pcb::parse_pcb;

    fn board(r1_x: f64, value: &str, extra: &str) -> String {
        format!(
            r#"(kicad_pcb (version 20240108) (net 0 "") (net 1 "GND")
              (footprint "R:R_0603" (layer "F.Cu") (uuid "fp-1") (at {r1_x} 10)
                (property "Reference" "R1") (property "Value" "{value}")
                (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "GND")))
              (segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "t-1"))
              {extra})"#
        )
    }

    #[test]
    fn detects_moved_and_changed_footprint() {
        let a = parse_pcb(&board(10.0, "10k", "")).unwrap();
        let b = parse_pcb(&board(12.5, "4k7", "")).unwrap();
        let d = diff_pcb(&a, &b);
        assert_eq!(d.summary.modified, 1);
        let c = &d.changes[0];
        assert_eq!(c.object, "footprint");
        let fields: Vec<&str> = c.fields.iter().map(|f| f.field.as_str()).collect();
        assert_eq!(fields, vec!["position", "value"]);
    }

    #[test]
    fn detects_added_track_and_net_reroute() {
        let a = parse_pcb(&board(10.0, "10k", "")).unwrap();
        let b = parse_pcb(&board(10.0, "10k", r#"(segment (start 5 0) (end 5 5) (width 0.25) (layer "F.Cu") (net 1) (uuid "t-2"))"#)).unwrap();
        let d = diff_pcb(&a, &b);
        assert_eq!(d.summary.added, 1);
        assert_eq!(d.changes[0].object, "track");
        assert_eq!(d.nets.len(), 1);
        assert_eq!(d.nets[0].tracks_after, 2);
    }

    #[test]
    fn identical_boards_have_no_changes() {
        let a = parse_pcb(&board(10.0, "10k", "")).unwrap();
        assert!(diff_pcb(&a, &a.clone()).changes.is_empty());
    }

    #[test]
    fn finds_conflicting_edits() {
        let base = parse_pcb(&board(10.0, "10k", "")).unwrap();
        let ours = parse_pcb(&board(10.0, "4k7", "")).unwrap();
        let theirs = parse_pcb(&board(10.0, "1k", "")).unwrap();
        let c = conflicts(&diff_pcb(&base, &ours), &diff_pcb(&base, &theirs));
        assert_eq!(c.len(), 1);
        let same = conflicts(&diff_pcb(&base, &ours), &diff_pcb(&base, &ours));
        assert!(same.is_empty());
    }
}
