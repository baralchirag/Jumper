//! Shared geometry primitives.

use serde::{Deserialize, Serialize};

use crate::sexpr::Sexp;

pub const EPS: f64 = 1e-6;

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

impl Pt {
    pub fn new(x: f64, y: f64) -> Self {
        Pt { x, y }
    }

    /// `(xy 1 2)`, `(at 1 2 90)`, `(start 1 2)`...
    pub fn from_node(node: &Sexp) -> Option<Pt> {
        Some(Pt::new(node.f64_at(1)?, node.f64_at(2)?))
    }

    pub fn approx_eq(&self, o: &Pt) -> bool {
        (self.x - o.x).abs() < EPS && (self.y - o.y).abs() < EPS
    }

    pub fn dist(&self, o: &Pt) -> f64 {
        ((self.x - o.x).powi(2) + (self.y - o.y).powi(2)).sqrt()
    }

    /// Rotate around the origin by `deg` counter-clockwise *as seen on screen*
    /// in KiCad's y-down coordinate system.
    pub fn rotate(&self, deg: f64) -> Pt {
        if deg.abs() < EPS {
            return *self;
        }
        let (s, c) = deg.to_radians().sin_cos();
        Pt::new(self.x * c + self.y * s, -self.x * s + self.y * c)
    }

    pub fn add(&self, o: &Pt) -> Pt {
        Pt::new(self.x + o.x, self.y + o.y)
    }
}

/// Position + orientation, as in `(at x y angle)`.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Placement {
    pub at: Pt,
    pub rotation: f64,
}

impl Placement {
    pub fn from_node(node: Option<&Sexp>) -> Placement {
        match node {
            Some(n) => Placement {
                at: Pt::from_node(n).unwrap_or_default(),
                rotation: n.f64_at(3).unwrap_or(0.0),
            },
            None => Placement::default(),
        }
    }

    /// Map a footprint-local point to board coordinates.
    pub fn apply(&self, local: &Pt) -> Pt {
        local.rotate(self.rotation).add(&self.at)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BBox {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl BBox {
    pub fn empty() -> Self {
        BBox { min_x: f64::INFINITY, min_y: f64::INFINITY, max_x: f64::NEG_INFINITY, max_y: f64::NEG_INFINITY }
    }

    pub fn is_empty(&self) -> bool {
        self.min_x > self.max_x || self.min_y > self.max_y
    }

    pub fn add_pt(&mut self, p: &Pt) {
        self.min_x = self.min_x.min(p.x);
        self.min_y = self.min_y.min(p.y);
        self.max_x = self.max_x.max(p.x);
        self.max_y = self.max_y.max(p.y);
    }

    pub fn add_circle(&mut self, c: &Pt, r: f64) {
        self.add_pt(&Pt::new(c.x - r, c.y - r));
        self.add_pt(&Pt::new(c.x + r, c.y + r));
    }

    pub fn union(&mut self, o: &BBox) {
        if o.is_empty() {
            return;
        }
        self.min_x = self.min_x.min(o.min_x);
        self.min_y = self.min_y.min(o.min_y);
        self.max_x = self.max_x.max(o.max_x);
        self.max_y = self.max_y.max(o.max_y);
    }

    pub fn inflate(mut self, d: f64) -> Self {
        if !self.is_empty() {
            self.min_x -= d;
            self.min_y -= d;
            self.max_x += d;
            self.max_y += d;
        }
        self
    }

    pub fn option(self) -> Option<BBox> {
        if self.is_empty() {
            None
        } else {
            Some(self)
        }
    }
}

/// Read every `(xy ..)` inside a `(pts ..)` node; `(arc (start)(mid)(end))`
/// segments are approximated by their three defining points.
pub fn read_pts(pts: Option<&Sexp>) -> Vec<Pt> {
    let mut out = Vec::new();
    let Some(pts) = pts else { return out };
    for item in pts.lists() {
        match item.head() {
            Some("xy") => {
                if let Some(p) = Pt::from_node(item) {
                    out.push(p);
                }
            }
            Some("arc") => {
                for key in ["start", "mid", "end"] {
                    if let Some(p) = item.find(key).and_then(Pt::from_node) {
                        out.push(p);
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// KiCad <= 6 stored arcs as center/start/angle. Convert to start/mid/end.
pub fn arc_from_center(center: Pt, start: Pt, angle_deg: f64) -> (Pt, Pt, Pt) {
    let rel = Pt::new(start.x - center.x, start.y - center.y);
    // KiCad's legacy angle is clockwise on screen in y-down coordinates.
    let mid = rel.rotate(-angle_deg / 2.0).add(&center);
    let end = rel.rotate(-angle_deg).add(&center);
    (start, mid, end)
}

pub fn round6(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}
