//! Typed model of a `.kicad_sch` file (KiCad 6+ S-expression format).
//!
//! Library symbol graphics are kept in library coordinates (y up); the
//! placement of each instance is exported so renderers apply the transform.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::geom::{read_pts, BBox, Placement, Pt};
use crate::sexpr::{self, Sexp};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schematic {
    pub version: Option<String>,
    pub generator: Option<String>,
    pub uuid: Option<String>,
    pub paper: Option<String>,
    pub title_block: BTreeMap<String, String>,
    pub lib_symbols: Vec<LibSymbol>,
    pub symbols: Vec<SchSymbol>,
    pub wires: Vec<Wire>,
    pub junctions: Vec<Junction>,
    pub no_connects: Vec<NoConnect>,
    pub bus_entries: Vec<BusEntry>,
    pub labels: Vec<Label>,
    pub sheets: Vec<Sheet>,
    pub graphics: Vec<SchGraphic>,
    pub texts: Vec<SchText>,
    pub bbox: Option<BBox>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibSymbol {
    pub id: String,
    pub extends: Option<String>,
    pub power: bool,
    pub pin_names_offset: f64,
    pub pin_names_hidden: bool,
    pub pin_numbers_hidden: bool,
    pub units: Vec<LibUnit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibUnit {
    /// 0 = shared by all units.
    pub unit: u32,
    /// 0 = shared by all body styles, 1 = normal, 2 = De Morgan.
    pub style: u32,
    pub graphics: Vec<SchGraphic>,
    pub pins: Vec<Pin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SchShape {
    Rect { start: Pt, end: Pt },
    Circle { center: Pt, radius: f64 },
    Arc { start: Pt, mid: Pt, end: Pt },
    Polyline { pts: Vec<Pt> },
    Bezier { pts: Vec<Pt> },
    Text { text: String, at: Pt, rotation: f64, size: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchGraphic {
    pub uuid: Option<String>,
    pub width: f64,
    /// none | outline | background | color
    pub fill: String,
    #[serde(flatten)]
    pub shape: SchShape,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    pub electrical: String,
    pub style: String,
    pub at: Pt,
    pub angle: f64,
    pub length: f64,
    pub name: String,
    pub number: String,
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Property {
    pub key: String,
    pub value: String,
    pub at: Pt,
    pub rotation: f64,
    pub size: f64,
    pub hidden: bool,
    pub justify: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchSymbol {
    pub uuid: String,
    pub lib_id: String,
    pub lib_name: Option<String>,
    pub at: Pt,
    pub rotation: f64,
    /// "x", "y" or None.
    pub mirror: Option<String>,
    pub unit: u32,
    pub body_style: u32,
    pub in_bom: bool,
    pub on_board: bool,
    pub dnp: bool,
    pub reference: String,
    pub value: String,
    pub footprint: String,
    pub properties: Vec<Property>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wire {
    pub uuid: String,
    /// "wire" | "bus"
    pub kind: String,
    pub pts: Vec<Pt>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Junction {
    pub uuid: String,
    pub at: Pt,
    pub diameter: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoConnect {
    pub uuid: String,
    pub at: Pt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusEntry {
    pub uuid: String,
    pub at: Pt,
    pub size: Pt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub uuid: String,
    /// local | global | hierarchical | netclass
    pub kind: String,
    pub text: String,
    pub at: Pt,
    pub rotation: f64,
    pub shape: Option<String>,
    pub size: f64,
    pub justify: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sheet {
    pub uuid: String,
    pub at: Pt,
    pub size: Pt,
    pub name: String,
    pub file: String,
    pub pins: Vec<SheetPin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetPin {
    pub uuid: Option<String>,
    pub name: String,
    pub shape: String,
    pub at: Pt,
    pub rotation: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchText {
    pub uuid: Option<String>,
    pub text: String,
    pub at: Pt,
    pub rotation: f64,
    pub size: f64,
    pub justify: Vec<String>,
}

pub fn parse_schematic(input: &str) -> Result<Schematic, String> {
    let root = sexpr::parse(input).map_err(|e| e.to_string())?;
    if !root.is("kicad_sch") {
        return Err("not a kicad_sch file".into());
    }
    Ok(from_sexp(&root))
}

fn uuid_of(node: &Sexp) -> Option<String> {
    node.value_of("uuid").map(str::to_string)
}

fn effects(node: &Sexp) -> (f64, bool, Vec<String>) {
    let eff = node.find("effects");
    let size = eff
        .and_then(|e| e.find("font"))
        .and_then(|f| f.find("size"))
        .and_then(|s| s.f64_at(1))
        .unwrap_or(1.27);
    let hidden = node.flag("hide") || eff.map(|e| e.flag("hide")).unwrap_or(false);
    let justify = eff
        .and_then(|e| e.find("justify"))
        .map(|j| j.items().iter().skip(1).filter_map(Sexp::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    (size, hidden, justify)
}

fn fill_type(node: &Sexp) -> String {
    node.find("fill").and_then(|f| f.value_of("type")).unwrap_or("none").to_string()
}

fn stroke_width(node: &Sexp) -> f64 {
    node.find("stroke").and_then(|s| s.f64_of("width")).unwrap_or(0.0)
}

fn read_graphic(node: &Sexp) -> Option<SchGraphic> {
    let p = |k: &str| node.find(k).and_then(Pt::from_node);
    let shape = match node.head()? {
        "rectangle" => SchShape::Rect { start: p("start")?, end: p("end")? },
        "circle" => SchShape::Circle { center: p("center")?, radius: node.f64_of("radius").unwrap_or(0.0) },
        "arc" => SchShape::Arc { start: p("start")?, mid: p("mid").or_else(|| p("start"))?, end: p("end")? },
        "polyline" => SchShape::Polyline { pts: read_pts(node.find("pts")) },
        "bezier" => SchShape::Bezier { pts: read_pts(node.find("pts")) },
        "text" => {
            let at = node.find("at");
            let (size, _, _) = effects(node);
            // Symbol library text angles are stored in tenths of a degree.
            let raw = at.and_then(|a| a.f64_at(3)).unwrap_or(0.0);
            SchShape::Text {
                text: node.str_at(1).unwrap_or("").to_string(),
                at: at.and_then(Pt::from_node).unwrap_or_default(),
                rotation: if raw.abs() > 360.0 { raw / 10.0 } else { raw },
                size,
            }
        }
        _ => return None,
    };
    Some(SchGraphic { uuid: uuid_of(node), width: stroke_width(node), fill: fill_type(node), shape })
}

fn read_pin(node: &Sexp) -> Pin {
    let at = node.find("at");
    Pin {
        electrical: node.str_at(1).unwrap_or("passive").to_string(),
        style: node.str_at(2).unwrap_or("line").to_string(),
        at: at.and_then(Pt::from_node).unwrap_or_default(),
        angle: at.and_then(|a| a.f64_at(3)).unwrap_or(0.0),
        length: node.f64_of("length").unwrap_or(2.54),
        name: node.find("name").and_then(|n| n.str_at(1)).unwrap_or("").to_string(),
        number: node.find("number").and_then(|n| n.str_at(1)).unwrap_or("").to_string(),
        hidden: node.flag("hide"),
    }
}

fn read_lib_symbol(node: &Sexp) -> LibSymbol {
    let id = node.str_at(1).unwrap_or("").to_string();
    let pin_names = node.find("pin_names");
    let mut units = Vec::new();

    // Graphics placed directly on the parent belong to every unit.
    let mut shared = LibUnit { unit: 0, style: 0, graphics: Vec::new(), pins: Vec::new() };
    for child in node.lists() {
        match child.head() {
            Some("symbol") => {
                // Name pattern: <name>_<unit>_<style>
                let name = child.str_at(1).unwrap_or("");
                let mut parts = name.rsplitn(3, '_');
                let style = parts.next().and_then(|s| s.parse().ok()).unwrap_or(1);
                let unit = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                let mut u = LibUnit { unit, style, graphics: Vec::new(), pins: Vec::new() };
                for g in child.lists() {
                    if g.is("pin") {
                        u.pins.push(read_pin(g));
                    } else if let Some(gr) = read_graphic(g) {
                        u.graphics.push(gr);
                    }
                }
                units.push(u);
            }
            Some("pin") => shared.pins.push(read_pin(child)),
            _ => {
                if let Some(gr) = read_graphic(child) {
                    shared.graphics.push(gr);
                }
            }
        }
    }
    if !shared.graphics.is_empty() || !shared.pins.is_empty() {
        units.push(shared);
    }

    LibSymbol {
        id,
        extends: node.value_of("extends").map(str::to_string),
        power: node.find("power").is_some() || node.has_atom("power"),
        pin_names_offset: pin_names.and_then(|p| p.f64_of("offset")).unwrap_or(0.508),
        pin_names_hidden: pin_names.map(|p| p.flag("hide")).unwrap_or(false),
        pin_numbers_hidden: node.find("pin_numbers").map(|p| p.flag("hide")).unwrap_or(false),
        units,
    }
}

fn read_symbol(node: &Sexp) -> SchSymbol {
    let place = Placement::from_node(node.find("at"));
    let mut properties = Vec::new();
    let mut reference = String::new();
    let mut value = String::new();
    let mut footprint = String::new();
    for prop in node.find_all("property") {
        let (Some(k), Some(v)) = (prop.str_at(1), prop.str_at(2)) else { continue };
        let at = prop.find("at");
        let (size, hidden, justify) = effects(prop);
        match k {
            "Reference" => reference = v.to_string(),
            "Value" => value = v.to_string(),
            "Footprint" => footprint = v.to_string(),
            _ => {}
        }
        properties.push(Property {
            key: k.to_string(),
            value: v.to_string(),
            at: at.and_then(Pt::from_node).unwrap_or(place.at),
            rotation: at.and_then(|a| a.f64_at(3)).unwrap_or(0.0),
            size,
            hidden,
            justify,
        });
    }
    // Hierarchical designs keep the per-instance reference here.
    if let Some(r) = node
        .find("instances")
        .and_then(|i| i.find("project"))
        .and_then(|p| p.find("path"))
        .and_then(|p| p.value_of("reference"))
    {
        if reference.is_empty() || reference.ends_with('?') {
            reference = r.to_string();
        }
    }
    let flag_default = |name: &str, default: bool| match node.find(name) {
        Some(n) => !matches!(n.str_at(1), Some("no")),
        None => default,
    };
    SchSymbol {
        uuid: uuid_of(node).unwrap_or_default(),
        lib_id: node.value_of("lib_id").unwrap_or("").to_string(),
        lib_name: node.value_of("lib_name").map(str::to_string),
        at: place.at,
        rotation: place.rotation,
        mirror: node.value_of("mirror").map(str::to_string),
        unit: node.f64_of("unit").unwrap_or(1.0) as u32,
        body_style: node.f64_of("convert").or_else(|| node.f64_of("body_style")).unwrap_or(1.0) as u32,
        in_bom: flag_default("in_bom", true),
        on_board: flag_default("on_board", true),
        dnp: flag_default("dnp", false),
        reference,
        value,
        footprint,
        properties,
    }
}

pub fn from_sexp(root: &Sexp) -> Schematic {
    let mut sch = Schematic {
        version: root.value_of("version").map(str::to_string),
        generator: root.value_of("generator").map(str::to_string),
        uuid: uuid_of(root),
        paper: root.value_of("paper").map(str::to_string),
        ..Default::default()
    };
    if let Some(tb) = root.find("title_block") {
        for item in tb.lists() {
            let (Some(k), Some(v)) = (item.head(), item.str_at(1)) else { continue };
            let key = if k == "comment" {
                format!("comment{}", v)
            } else {
                k.to_string()
            };
            let val = if k == "comment" { item.str_at(2).unwrap_or("") } else { v };
            sch.title_block.insert(key, val.to_string());
        }
    }
    if let Some(libs) = root.find("lib_symbols") {
        sch.lib_symbols = libs.find_all("symbol").map(read_lib_symbol).collect();
        // Resolve `extends` by copying the parent's drawing.
        let snapshot = sch.lib_symbols.clone();
        for ls in &mut sch.lib_symbols {
            if ls.units.is_empty() {
                if let Some(parent) = ls.extends.as_ref().and_then(|p| snapshot.iter().find(|s| s.id.ends_with(p.as_str()))) {
                    ls.units = parent.units.clone();
                }
            }
        }
    }

    for node in root.lists() {
        match node.head() {
            Some("symbol") => sch.symbols.push(read_symbol(node)),
            Some(k @ ("wire" | "bus")) => sch.wires.push(Wire {
                uuid: uuid_of(node).unwrap_or_default(),
                kind: k.to_string(),
                pts: read_pts(node.find("pts")),
            }),
            Some("junction") => sch.junctions.push(Junction {
                uuid: uuid_of(node).unwrap_or_default(),
                at: node.find("at").and_then(Pt::from_node).unwrap_or_default(),
                diameter: node.f64_of("diameter").filter(|d| *d > 0.0).unwrap_or(0.9144),
            }),
            Some("no_connect") => sch.no_connects.push(NoConnect {
                uuid: uuid_of(node).unwrap_or_default(),
                at: node.find("at").and_then(Pt::from_node).unwrap_or_default(),
            }),
            Some("bus_entry") => sch.bus_entries.push(BusEntry {
                uuid: uuid_of(node).unwrap_or_default(),
                at: node.find("at").and_then(Pt::from_node).unwrap_or_default(),
                size: node.find("size").and_then(Pt::from_node).unwrap_or_default(),
            }),
            Some(k @ ("label" | "global_label" | "hierarchical_label" | "netclass_flag")) => {
                let at = node.find("at");
                let (size, _, justify) = effects(node);
                sch.labels.push(Label {
                    uuid: uuid_of(node).unwrap_or_default(),
                    kind: match k {
                        "label" => "local",
                        "global_label" => "global",
                        "hierarchical_label" => "hierarchical",
                        _ => "netclass",
                    }
                    .to_string(),
                    text: node.str_at(1).unwrap_or("").to_string(),
                    at: at.and_then(Pt::from_node).unwrap_or_default(),
                    rotation: at.and_then(|a| a.f64_at(3)).unwrap_or(0.0),
                    shape: node.value_of("shape").map(str::to_string),
                    size,
                    justify,
                });
            }
            Some("sheet") => {
                let mut name = String::new();
                let mut file = String::new();
                for prop in node.find_all("property") {
                    match (prop.str_at(1), prop.str_at(2)) {
                        (Some("Sheetname") | Some("Sheet name"), Some(v)) => name = v.to_string(),
                        (Some("Sheetfile") | Some("Sheet file"), Some(v)) => file = v.to_string(),
                        _ => {}
                    }
                }
                let pins = node
                    .find_all("pin")
                    .map(|p| {
                        let at = p.find("at");
                        SheetPin {
                            uuid: uuid_of(p),
                            name: p.str_at(1).unwrap_or("").to_string(),
                            shape: p.str_at(2).unwrap_or("").to_string(),
                            at: at.and_then(Pt::from_node).unwrap_or_default(),
                            rotation: at.and_then(|a| a.f64_at(3)).unwrap_or(0.0),
                        }
                    })
                    .collect();
                sch.sheets.push(Sheet {
                    uuid: uuid_of(node).unwrap_or_default(),
                    at: node.find("at").and_then(Pt::from_node).unwrap_or_default(),
                    size: node.find("size").and_then(Pt::from_node).unwrap_or_default(),
                    name,
                    file,
                    pins,
                });
            }
            Some("text") => {
                let at = node.find("at");
                let (size, _, justify) = effects(node);
                sch.texts.push(SchText {
                    uuid: uuid_of(node),
                    text: node.str_at(1).unwrap_or("").to_string(),
                    at: at.and_then(Pt::from_node).unwrap_or_default(),
                    rotation: at.and_then(|a| a.f64_at(3)).unwrap_or(0.0),
                    size,
                    justify,
                });
            }
            Some("polyline") | Some("rectangle") | Some("circle") | Some("arc") | Some("bezier") => {
                if let Some(g) = read_graphic(node) {
                    sch.graphics.push(g);
                }
            }
            _ => {}
        }
    }

    let mut bb = BBox::empty();
    for s in &sch.symbols {
        bb.add_circle(&s.at, 5.08);
    }
    for w in &sch.wires {
        w.pts.iter().for_each(|p| bb.add_pt(p));
    }
    for l in &sch.labels {
        bb.add_circle(&l.at, 2.54);
    }
    for s in &sch.sheets {
        bb.add_pt(&s.at);
        bb.add_pt(&s.at.add(&s.size));
    }
    for t in &sch.texts {
        bb.add_circle(&t.at, 2.54);
    }
    sch.bbox = bb.option();
    sch
}

impl Schematic {
    pub fn lib_symbol(&self, sym: &SchSymbol) -> Option<&LibSymbol> {
        let key = sym.lib_name.as_deref().unwrap_or(&sym.lib_id);
        self.lib_symbols.iter().find(|l| l.id == key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINI: &str = r#"(kicad_sch (version 20231120) (generator "eeschema") (uuid "root")
      (paper "A4")
      (lib_symbols
        (symbol "Device:R" (pin_numbers hide) (pin_names (offset 0))
          (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254)) (fill (type none))))
          (symbol "R_1_1"
            (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
            (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2")))))
      (wire (pts (xy 100 50) (xy 110 50)) (stroke (width 0)) (uuid "w-1"))
      (label "SDA" (at 100 50 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid "l-1"))
      (symbol (lib_id "Device:R") (at 120 50 90) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "s-1")
        (property "Reference" "R1" (at 120 47 90) (effects (font (size 1.27 1.27))))
        (property "Value" "4k7" (at 120 53 90) (effects (font (size 1.27 1.27))))
        (property "Footprint" "Resistor_SMD:R_0603" (at 120 50 0) (effects (font (size 1.27 1.27)) hide))))"#;

    #[test]
    fn parses_minimal_schematic() {
        let s = parse_schematic(MINI).unwrap();
        assert_eq!(s.lib_symbols.len(), 1);
        let lib = &s.lib_symbols[0];
        assert!(lib.pin_numbers_hidden);
        assert_eq!(lib.units.len(), 2);
        assert_eq!(lib.units.iter().map(|u| u.pins.len()).sum::<usize>(), 2);
        let sym = &s.symbols[0];
        assert_eq!(sym.reference, "R1");
        assert_eq!(sym.value, "4k7");
        assert_eq!(sym.footprint, "Resistor_SMD:R_0603");
        assert!(sym.properties.iter().find(|p| p.key == "Footprint").unwrap().hidden);
        assert!(!sym.dnp);
        assert_eq!(s.wires[0].pts.len(), 2);
        assert_eq!(s.labels[0].text, "SDA");
        assert!(s.lib_symbol(sym).is_some());
    }
}
