//! Typed model of a `.kicad_pcb` file (KiCad 6+ S-expression format).
//!
//! All footprint children (pads, graphics, texts) are emitted in *board*
//! coordinates so consumers (viewer, diff) never need to re-apply transforms.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use crate::geom::{arc_from_center, read_pts, BBox, Placement, Pt};
use crate::sexpr::{self, Sexp};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pcb {
    pub version: Option<String>,
    pub generator: Option<String>,
    pub thickness: Option<f64>,
    pub layers: Vec<LayerDef>,
    pub nets: Vec<Net>,
    pub footprints: Vec<Footprint>,
    pub tracks: Vec<Track>,
    pub vias: Vec<Via>,
    pub zones: Vec<Zone>,
    pub graphics: Vec<Graphic>,
    pub texts: Vec<Text>,
    pub bbox: Option<BBox>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerDef {
    pub ordinal: i32,
    pub name: String,
    pub kind: String,
    pub user_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Net {
    pub id: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Footprint {
    pub uuid: String,
    pub lib_id: String,
    pub reference: String,
    pub value: String,
    pub at: Pt,
    pub rotation: f64,
    pub layer: String,
    pub locked: bool,
    pub attrs: Vec<String>,
    pub properties: BTreeMap<String, String>,
    pub pads: Vec<Pad>,
    pub graphics: Vec<Graphic>,
    pub texts: Vec<Text>,
    pub models: Vec<String>,
    pub bbox: Option<BBox>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pad {
    pub number: String,
    pub kind: String,
    pub shape: String,
    pub at: Pt,
    pub rotation: f64,
    pub size: Pt,
    pub drill: Option<Drill>,
    pub layers: Vec<String>,
    pub net: u32,
    pub net_name: String,
    pub roundrect_rratio: f64,
    /// Custom pad primitives (polygons in board coordinates).
    pub polygons: Vec<Vec<Pt>>,
    pub uuid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Drill {
    pub oval: bool,
    pub width: f64,
    pub height: f64,
    pub offset: Pt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub uuid: String,
    pub start: Pt,
    pub end: Pt,
    /// Present for arc tracks.
    pub mid: Option<Pt>,
    pub width: f64,
    pub layer: String,
    pub net: u32,
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Via {
    pub uuid: String,
    pub at: Pt,
    pub size: f64,
    pub drill: f64,
    pub layers: Vec<String>,
    pub net: u32,
    pub via_type: String,
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Zone {
    pub uuid: String,
    pub net: u32,
    pub net_name: String,
    pub name: Option<String>,
    pub layers: Vec<String>,
    pub priority: i64,
    pub keepout: bool,
    pub outline: Vec<Pt>,
    pub fills: Vec<ZoneFill>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneFill {
    pub layer: String,
    pub pts: Vec<Pt>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Shape {
    Line { start: Pt, end: Pt },
    Arc { start: Pt, mid: Pt, end: Pt },
    Circle { center: Pt, end: Pt },
    Rect { start: Pt, end: Pt },
    Poly { pts: Vec<Pt> },
    Curve { pts: Vec<Pt> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Graphic {
    pub uuid: Option<String>,
    pub layer: String,
    pub width: f64,
    pub fill: bool,
    #[serde(flatten)]
    pub shape: Shape,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Text {
    pub uuid: Option<String>,
    pub kind: String,
    pub text: String,
    pub at: Pt,
    pub rotation: f64,
    pub layer: String,
    pub size: Pt,
    pub thickness: f64,
    pub hidden: bool,
    pub mirror: bool,
    pub justify: Vec<String>,
}

pub fn parse_pcb(input: &str) -> Result<Pcb, String> {
    let root = sexpr::parse(input).map_err(|e| e.to_string())?;
    if !root.is("kicad_pcb") {
        return Err("not a kicad_pcb file".into());
    }
    Ok(from_sexp(&root))
}

fn uuid_of(node: &Sexp) -> Option<String> {
    node.value_of("uuid").or_else(|| node.value_of("tstamp")).map(str::to_string)
}

fn net_ref(node: &Sexp, by_name: &HashMap<String, u32>) -> u32 {
    match node.find("net") {
        Some(n) => match n.str_at(1) {
            Some(v) => v.parse::<u32>().unwrap_or_else(|_| by_name.get(v).copied().unwrap_or(0)),
            None => 0,
        },
        None => 0,
    }
}

fn stroke_width(node: &Sexp) -> f64 {
    node.find("stroke")
        .and_then(|s| s.f64_of("width"))
        .or_else(|| node.f64_of("width"))
        .unwrap_or(0.0)
}

fn is_filled(node: &Sexp) -> bool {
    match node.value_of("fill") {
        Some(v) => matches!(v, "solid" | "yes" | "true"),
        None => false,
    }
}

fn read_shape(node: &Sexp) -> Option<Shape> {
    let head = node.head()?;
    let kind = head.split_once('_').map(|(_, k)| k).unwrap_or(head);
    let p = |k: &str| node.find(k).and_then(Pt::from_node);
    Some(match kind {
        "line" => Shape::Line { start: p("start")?, end: p("end")? },
        "rect" => Shape::Rect { start: p("start")?, end: p("end")? },
        "circle" => Shape::Circle { center: p("center")?, end: p("end")? },
        "arc" => match (p("mid"), node.f64_of("angle")) {
            (Some(mid), _) => Shape::Arc { start: p("start")?, mid, end: p("end")? },
            (None, Some(angle)) => {
                let (start, mid, end) = arc_from_center(p("start")?, p("end")?, angle);
                Shape::Arc { start, mid, end }
            }
            _ => return None,
        },
        "poly" => Shape::Poly { pts: read_pts(node.find("pts")) },
        "curve" => Shape::Curve { pts: read_pts(node.find("pts")) },
        _ => return None,
    })
}

fn transform_shape(shape: &Shape, place: &Placement) -> Shape {
    let t = |p: &Pt| place.apply(p);
    match shape {
        Shape::Line { start, end } => Shape::Line { start: t(start), end: t(end) },
        Shape::Arc { start, mid, end } => Shape::Arc { start: t(start), mid: t(mid), end: t(end) },
        Shape::Circle { center, end } => Shape::Circle { center: t(center), end: t(end) },
        // A rotated rectangle is no longer axis-aligned: emit it as a polygon.
        Shape::Rect { start, end } => {
            if place.rotation.abs() < 1e-9 {
                Shape::Rect { start: t(start), end: t(end) }
            } else {
                let c = [*start, Pt::new(end.x, start.y), *end, Pt::new(start.x, end.y)];
                Shape::Poly { pts: c.iter().map(t).collect() }
            }
        }
        Shape::Poly { pts } => Shape::Poly { pts: pts.iter().map(t).collect() },
        Shape::Curve { pts } => Shape::Curve { pts: pts.iter().map(t).collect() },
    }
}

pub fn shape_bbox(shape: &Shape, width: f64) -> BBox {
    let mut b = BBox::empty();
    match shape {
        Shape::Line { start, end } | Shape::Rect { start, end } => {
            b.add_pt(start);
            b.add_pt(end);
        }
        Shape::Arc { start, mid, end } => {
            b.add_pt(start);
            b.add_pt(mid);
            b.add_pt(end);
        }
        Shape::Circle { center, end } => b.add_circle(center, center.dist(end)),
        Shape::Poly { pts } | Shape::Curve { pts } => pts.iter().for_each(|p| b.add_pt(p)),
    }
    b.inflate(width / 2.0)
}

fn read_text(node: &Sexp, kind: &str, text: &str, place: Option<&Placement>) -> Text {
    let at_node = node.find("at");
    let local = at_node.and_then(Pt::from_node).unwrap_or_default();
    let rotation = at_node.and_then(|a| a.f64_at(3)).unwrap_or(0.0);
    let effects = node.find("effects");
    let font = effects.and_then(|e| e.find("font"));
    let size = font.and_then(|f| f.find("size")).and_then(Pt::from_node).unwrap_or(Pt::new(1.0, 1.0));
    let justify_node = effects.and_then(|e| e.find("justify"));
    let justify: Vec<String> = justify_node
        .map(|j| j.items().iter().skip(1).filter_map(Sexp::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    Text {
        uuid: uuid_of(node),
        kind: kind.to_string(),
        text: text.to_string(),
        at: place.map(|p| p.apply(&local)).unwrap_or(local),
        rotation,
        layer: node.value_of("layer").unwrap_or("").to_string(),
        size,
        thickness: font.and_then(|f| f.f64_of("thickness")).unwrap_or(0.15),
        hidden: node.flag("hide") || effects.map(|e| e.flag("hide")).unwrap_or(false),
        mirror: justify.iter().any(|j| j == "mirror"),
        justify,
    }
}

fn layer_list(node: &Sexp) -> Vec<String> {
    node.find("layers")
        .map(|l| l.items().iter().skip(1).filter_map(Sexp::as_str).map(str::to_string).collect())
        .or_else(|| node.value_of("layer").map(|l| vec![l.to_string()]))
        .unwrap_or_default()
}

fn read_pad(node: &Sexp, place: &Placement, by_name: &HashMap<String, u32>) -> Pad {
    let at_node = node.find("at");
    let local = at_node.and_then(Pt::from_node).unwrap_or_default();
    let net_node = node.find("net");
    let drill = node.find("drill").map(|d| {
        let mut nums = d.items().iter().skip(1).filter_map(|s| s.as_str()?.parse::<f64>().ok());
        let w = nums.next().unwrap_or(0.0);
        let h = nums.next().unwrap_or(w);
        Drill {
            oval: d.has_atom("oval"),
            width: w,
            height: h,
            offset: d.find("offset").and_then(Pt::from_node).unwrap_or_default(),
        }
    });
    let pad_rot = at_node.and_then(|a| a.f64_at(3)).unwrap_or(0.0);
    let center = place.apply(&local);
    let polygons = node
        .find("primitives")
        .map(|prims| {
            prims
                .find_all("gr_poly")
                .map(|g| {
                    let pad_place = Placement { at: center, rotation: pad_rot };
                    read_pts(g.find("pts")).iter().map(|p| pad_place.apply(p)).collect()
                })
                .collect()
        })
        .unwrap_or_default();
    Pad {
        number: node.str_at(1).unwrap_or("").to_string(),
        kind: node.str_at(2).unwrap_or("").to_string(),
        shape: node.str_at(3).unwrap_or("").to_string(),
        at: center,
        rotation: pad_rot,
        size: node.find("size").and_then(Pt::from_node).unwrap_or_default(),
        drill,
        layers: layer_list(node),
        net: net_ref(node, by_name),
        net_name: net_node.and_then(|n| n.str_at(2)).unwrap_or("").to_string(),
        roundrect_rratio: node.f64_of("roundrect_rratio").unwrap_or(0.25),
        polygons,
        uuid: uuid_of(node),
    }
}

fn read_footprint(node: &Sexp, by_name: &HashMap<String, u32>, nets: &HashMap<u32, String>) -> Footprint {
    let place = Placement::from_node(node.find("at"));
    let mut properties = BTreeMap::new();
    let mut texts = Vec::new();
    let mut reference = String::new();
    let mut value = String::new();

    for prop in node.find_all("property") {
        let (Some(k), Some(v)) = (prop.str_at(1), prop.str_at(2)) else { continue };
        properties.insert(k.to_string(), v.to_string());
        match k {
            "Reference" => reference = v.to_string(),
            "Value" => value = v.to_string(),
            _ => {}
        }
        if prop.find("layer").is_some() && prop.find("at").is_some() {
            texts.push(read_text(prop, &k.to_lowercase(), v, Some(&place)));
        }
    }
    for t in node.find_all("fp_text") {
        let kind = t.str_at(1).unwrap_or("user");
        let txt = t.str_at(2).unwrap_or("");
        match kind {
            "reference" if reference.is_empty() => reference = txt.to_string(),
            "value" if value.is_empty() => value = txt.to_string(),
            _ => {}
        }
        texts.push(read_text(t, kind, txt, Some(&place)));
    }

    let mut graphics = Vec::new();
    for g in node.lists() {
        let Some(h) = g.head() else { continue };
        if !h.starts_with("fp_") || h == "fp_text" || h == "fp_text_box" {
            continue;
        }
        if let Some(shape) = read_shape(g) {
            graphics.push(Graphic {
                uuid: uuid_of(g),
                layer: g.value_of("layer").unwrap_or("").to_string(),
                width: stroke_width(g),
                fill: is_filled(g),
                shape: transform_shape(&shape, &place),
            });
        }
    }

    let mut pads: Vec<Pad> = node.find_all("pad").map(|p| read_pad(p, &place, by_name)).collect();
    for pad in &mut pads {
        if pad.net_name.is_empty() {
            if let Some(n) = nets.get(&pad.net) {
                pad.net_name = n.clone();
            }
        }
    }

    let mut bbox = BBox::empty();
    bbox.add_pt(&place.at);
    for p in &pads {
        let r = p.size.x.max(p.size.y) / 2.0;
        bbox.add_circle(&p.at, r);
    }
    for g in &graphics {
        if g.layer.ends_with("CrtYd") || g.layer.ends_with("Fab") || g.layer.ends_with("SilkS") {
            bbox.union(&shape_bbox(&g.shape, g.width));
        }
    }

    let attrs = node
        .find("attr")
        .map(|a| a.items().iter().skip(1).filter_map(Sexp::as_str).map(str::to_string).collect())
        .unwrap_or_default();

    Footprint {
        uuid: uuid_of(node).unwrap_or_default(),
        lib_id: node.str_at(1).unwrap_or("").to_string(),
        reference,
        value,
        at: place.at,
        rotation: place.rotation,
        layer: node.value_of("layer").unwrap_or("F.Cu").to_string(),
        locked: node.flag("locked"),
        attrs,
        properties,
        pads,
        graphics,
        texts,
        models: node.find_all("model").filter_map(|m| m.str_at(1)).map(str::to_string).collect(),
        bbox: bbox.option(),
    }
}

pub fn from_sexp(root: &Sexp) -> Pcb {
    let mut pcb = Pcb {
        version: root.value_of("version").map(str::to_string),
        generator: root.value_of("generator").map(str::to_string),
        thickness: root.find("general").and_then(|g| g.f64_of("thickness")),
        ..Default::default()
    };

    if let Some(layers) = root.find("layers") {
        for l in layers.lists() {
            let (Some(ord), Some(name)) = (l.f64_at(0).or_else(|| l.head().and_then(|h| h.parse().ok())), l.str_at(1)) else {
                continue;
            };
            pcb.layers.push(LayerDef {
                ordinal: ord as i32,
                name: name.to_string(),
                kind: l.str_at(2).unwrap_or("user").to_string(),
                user_name: l.str_at(3).map(str::to_string),
            });
        }
    }

    for n in root.find_all("net") {
        if let (Some(id), Some(name)) = (n.f64_at(1), n.str_at(2)) {
            pcb.nets.push(Net { id: id as u32, name: name.to_string() });
        }
    }
    let by_name: HashMap<String, u32> = pcb.nets.iter().map(|n| (n.name.clone(), n.id)).collect();
    let by_id: HashMap<u32, String> = pcb.nets.iter().map(|n| (n.id, n.name.clone())).collect();

    for node in root.lists() {
        match node.head() {
            Some("footprint") | Some("module") => pcb.footprints.push(read_footprint(node, &by_name, &by_id)),
            Some(h @ ("segment" | "arc")) => {
                let p = |k: &str| node.find(k).and_then(Pt::from_node);
                let (Some(start), Some(end)) = (p("start"), p("end")) else { continue };
                pcb.tracks.push(Track {
                    uuid: uuid_of(node).unwrap_or_default(),
                    start,
                    end,
                    mid: if h == "arc" { p("mid") } else { None },
                    width: node.f64_of("width").unwrap_or(0.25),
                    layer: node.value_of("layer").unwrap_or("").to_string(),
                    net: net_ref(node, &by_name),
                    locked: node.flag("locked"),
                });
            }
            Some("via") => {
                let Some(at) = node.find("at").and_then(Pt::from_node) else { continue };
                let via_type = node
                    .items()
                    .iter()
                    .skip(1)
                    .find_map(|s| match s {
                        Sexp::Atom(a) if a == "blind" || a == "micro" => Some(a.clone()),
                        _ => None,
                    })
                    .unwrap_or_else(|| "through".to_string());
                pcb.vias.push(Via {
                    uuid: uuid_of(node).unwrap_or_default(),
                    at,
                    size: node.f64_of("size").unwrap_or(0.6),
                    drill: node.f64_of("drill").unwrap_or(0.3),
                    layers: layer_list(node),
                    net: net_ref(node, &by_name),
                    via_type,
                    locked: node.flag("locked"),
                });
            }
            Some("zone") => {
                let net = net_ref(node, &by_name);
                let fills = node
                    .find_all("filled_polygon")
                    .map(|f| ZoneFill {
                        layer: f.value_of("layer").unwrap_or("").to_string(),
                        pts: read_pts(f.find("pts")),
                    })
                    .collect();
                pcb.zones.push(Zone {
                    uuid: uuid_of(node).unwrap_or_default(),
                    net,
                    net_name: node
                        .value_of("net_name")
                        .map(str::to_string)
                        .or_else(|| by_id.get(&net).cloned())
                        .unwrap_or_default(),
                    name: node.value_of("name").map(str::to_string),
                    layers: layer_list(node),
                    priority: node.f64_of("priority").unwrap_or(0.0) as i64,
                    keepout: node.find("keepout").is_some(),
                    outline: read_pts(node.find("polygon").and_then(|p| p.find("pts"))),
                    fills,
                });
            }
            Some("gr_text") => {
                let txt = node.str_at(1).unwrap_or("");
                pcb.texts.push(read_text(node, "user", txt, None));
            }
            Some(h) if h.starts_with("gr_") => {
                if let Some(shape) = read_shape(node) {
                    pcb.graphics.push(Graphic {
                        uuid: uuid_of(node),
                        layer: node.value_of("layer").unwrap_or("").to_string(),
                        width: stroke_width(node),
                        fill: is_filled(node),
                        shape,
                    });
                }
            }
            _ => {}
        }
    }

    let mut edge = BBox::empty();
    for g in pcb.graphics.iter().filter(|g| g.layer == "Edge.Cuts") {
        edge.union(&shape_bbox(&g.shape, g.width));
    }
    for fp in &pcb.footprints {
        for g in fp.graphics.iter().filter(|g| g.layer == "Edge.Cuts") {
            edge.union(&shape_bbox(&g.shape, g.width));
        }
    }
    if edge.is_empty() {
        for fp in &pcb.footprints {
            if let Some(b) = &fp.bbox {
                edge.union(b);
            }
        }
        for t in &pcb.tracks {
            edge.add_pt(&t.start);
            edge.add_pt(&t.end);
        }
        for g in &pcb.graphics {
            edge.union(&shape_bbox(&g.shape, g.width));
        }
    }
    pcb.bbox = edge.option();
    pcb
}

impl Pcb {
    pub fn net_name(&self, id: u32) -> &str {
        self.nets.iter().find(|n| n.id == id).map(|n| n.name.as_str()).unwrap_or("")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINI: &str = r#"(kicad_pcb (version 20240108) (generator "pcbnew")
      (general (thickness 1.6))
      (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
      (net 0 "") (net 1 "GND")
      (footprint "R:R_0603" (layer "F.Cu") (uuid "fp-1") (at 10 10 90)
        (property "Reference" "R1" (at 0 -1.4 90) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
        (property "Value" "10k" (at 0 1.4 90) (layer "F.Fab"))
        (pad "1" smd roundrect (at -0.8 0 90) (size 0.8 0.9) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "GND")))
      (segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "t-1"))
      (via (at 5 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v-1"))
      (gr_rect (start 0 0) (end 20 20) (stroke (width 0.1) (type solid)) (fill none) (layer "Edge.Cuts") (uuid "e-1")))"#;

    #[test]
    fn parses_minimal_board() {
        let pcb = parse_pcb(MINI).unwrap();
        assert_eq!(pcb.layers.len(), 3);
        assert_eq!(pcb.net_name(1), "GND");
        let fp = &pcb.footprints[0];
        assert_eq!(fp.reference, "R1");
        assert_eq!(fp.value, "10k");
        // pad at local (-0.8, 0) rotated 90deg CCW -> (0, +0.8) offset on screen
        assert!((fp.pads[0].at.x - 10.0).abs() < 1e-9);
        assert!((fp.pads[0].at.y - 10.8).abs() < 1e-9);
        assert_eq!(fp.pads[0].net_name, "GND");
        assert_eq!(pcb.tracks.len(), 1);
        assert_eq!(pcb.vias.len(), 1);
        let bb = pcb.bbox.unwrap();
        assert!((bb.max_x - 20.05).abs() < 1e-9);
    }
}
