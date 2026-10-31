// TypeScript mirror of the serde output of the Rust crate (src/*.rs).
// Keep in sync when changing the Rust structs.

export interface Pt {
  x: number;
  y: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// ---------- PCB ----------

export type Shape =
  | { type: 'line'; start: Pt; end: Pt }
  | { type: 'arc'; start: Pt; mid: Pt; end: Pt }
  | { type: 'circle'; center: Pt; end: Pt }
  | { type: 'rect'; start: Pt; end: Pt }
  | { type: 'poly'; pts: Pt[] }
  | { type: 'curve'; pts: Pt[] };

export type Graphic = Shape & {
  uuid: string | null;
  layer: string;
  width: number;
  fill: boolean;
};

export interface PcbText {
  uuid: string | null;
  kind: string;
  text: string;
  at: Pt;
  rotation: number;
  layer: string;
  size: Pt;
  thickness: number;
  hidden: boolean;
  mirror: boolean;
  justify: string[];
}

export interface Drill {
  oval: boolean;
  width: number;
  height: number;
  offset: Pt;
}

export interface Pad {
  number: string;
  kind: 'smd' | 'thru_hole' | 'np_thru_hole' | 'connect' | string;
  shape: 'circle' | 'rect' | 'oval' | 'roundrect' | 'trapezoid' | 'custom' | string;
  at: Pt;
  rotation: number;
  size: Pt;
  drill: Drill | null;
  layers: string[];
  net: number;
  netName: string;
  roundrectRratio: number;
  polygons: Pt[][];
  uuid: string | null;
}

export interface Footprint {
  uuid: string;
  libId: string;
  reference: string;
  value: string;
  at: Pt;
  rotation: number;
  layer: string;
  locked: boolean;
  attrs: string[];
  properties: Record<string, string>;
  pads: Pad[];
  graphics: Graphic[];
  texts: PcbText[];
  models: string[];
  bbox: BBox | null;
}

export interface Track {
  uuid: string;
  start: Pt;
  end: Pt;
  mid: Pt | null;
  width: number;
  layer: string;
  net: number;
  locked: boolean;
}

export interface Via {
  uuid: string;
  at: Pt;
  size: number;
  drill: number;
  layers: string[];
  net: number;
  viaType: string;
  locked: boolean;
}

export interface Zone {
  uuid: string;
  net: number;
  netName: string;
  name: string | null;
  layers: string[];
  priority: number;
  keepout: boolean;
  outline: Pt[];
  fills: { layer: string; pts: Pt[] }[];
}

export interface LayerDef {
  ordinal: number;
  name: string;
  kind: string;
  userName: string | null;
}

export interface Pcb {
  version: string | null;
  generator: string | null;
  thickness: number | null;
  layers: LayerDef[];
  nets: { id: number; name: string }[];
  footprints: Footprint[];
  tracks: Track[];
  vias: Via[];
  zones: Zone[];
  graphics: Graphic[];
  texts: PcbText[];
  bbox: BBox | null;
}

// ---------- Schematic ----------

export type SchShape =
  | { type: 'rect'; start: Pt; end: Pt }
  | { type: 'circle'; center: Pt; radius: number }
  | { type: 'arc'; start: Pt; mid: Pt; end: Pt }
  | { type: 'polyline'; pts: Pt[] }
  | { type: 'bezier'; pts: Pt[] }
  | { type: 'text'; text: string; at: Pt; rotation: number; size: number };

export type SchGraphic = SchShape & {
  uuid: string | null;
  width: number;
  fill: 'none' | 'outline' | 'background' | 'color' | string;
};

export interface Pin {
  electrical: string;
  style: string;
  at: Pt;
  angle: number;
  length: number;
  name: string;
  number: string;
  hidden: boolean;
}

export interface LibSymbol {
  id: string;
  extends: string | null;
  power: boolean;
  pinNamesOffset: number;
  pinNamesHidden: boolean;
  pinNumbersHidden: boolean;
  units: { unit: number; style: number; graphics: SchGraphic[]; pins: Pin[] }[];
}

export interface SchProperty {
  key: string;
  value: string;
  at: Pt;
  rotation: number;
  size: number;
  hidden: boolean;
  justify: string[];
}

export interface SchSymbol {
  uuid: string;
  libId: string;
  libName: string | null;
  at: Pt;
  rotation: number;
  mirror: 'x' | 'y' | null;
  unit: number;
  bodyStyle: number;
  inBom: boolean;
  onBoard: boolean;
  dnp: boolean;
  reference: string;
  value: string;
  footprint: string;
  properties: SchProperty[];
}

export interface Label {
  uuid: string;
  kind: 'local' | 'global' | 'hierarchical' | 'netclass';
  text: string;
  at: Pt;
  rotation: number;
  shape: string | null;
  size: number;
  justify: string[];
}

export interface Sheet {
  uuid: string;
  at: Pt;
  size: Pt;
  name: string;
  file: string;
  pins: { uuid: string | null; name: string; shape: string; at: Pt; rotation: number }[];
}

export interface Schematic {
  version: string | null;
  generator: string | null;
  uuid: string | null;
  paper: string | null;
  titleBlock: Record<string, string>;
  libSymbols: LibSymbol[];
  symbols: SchSymbol[];
  wires: { uuid: string; kind: 'wire' | 'bus'; pts: Pt[] }[];
  junctions: { uuid: string; at: Pt; diameter: number }[];
  noConnects: { uuid: string; at: Pt }[];
  busEntries: { uuid: string; at: Pt; size: Pt }[];
  labels: Label[];
  sheets: Sheet[];
  graphics: SchGraphic[];
  texts: { uuid: string | null; text: string; at: Pt; rotation: number; size: number; justify: string[] }[];
  bbox: BBox | null;
}

export type ParsedDesign = { kind: 'pcb'; model: Pcb } | { kind: 'schematic'; model: Schematic };
export type DesignKind = ParsedDesign['kind'];

// ---------- Diff ----------

export type ChangeOp = 'added' | 'removed' | 'modified';

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface Change {
  op: ChangeOp;
  object: string;
  id: string;
  label: string;
  layer: string | null;
  bbox: BBox | null;
  fields: FieldChange[];
}

export interface NetChange {
  name: string;
  op: ChangeOp;
  tracksBefore: number;
  tracksAfter: number;
  viasBefore: number;
  viasAfter: number;
  lengthBefore: number;
  lengthAfter: number;
  padsBefore: string[];
  padsAfter: string[];
}

export interface DiffCounts {
  added: number;
  removed: number;
  modified: number;
}

export interface DiffResult {
  kind: 'pcb' | 'schematic';
  summary: DiffCounts & { byObject: Record<string, DiffCounts> };
  changes: Change[];
  nets: NetChange[];
}

export interface Conflict {
  object: string;
  id: string;
  label: string;
  bbox: BBox | null;
  ours: Change;
  theirs: Change;
}

// ---------- BOM ----------

export interface BomLine {
  references: string[];
  quantity: number;
  value: string;
  footprint: string;
  libId: string;
  dnp: boolean;
  fields: Record<string, string>;
}

export interface BomChange {
  op: ChangeOp;
  value: string;
  footprint: string;
  quantityBefore: number;
  quantityAfter: number;
  referencesAdded: string[];
  referencesRemoved: string[];
}

export type KindHint = 'pcb' | 'sch' | 'auto';

export function kindFromPath(path: string): 'pcb' | 'sch' | null {
  if (path.endsWith('.kicad_pcb')) return 'pcb';
  if (path.endsWith('.kicad_sch')) return 'sch';
  return null;
}

/** API shared by the Node and browser bindings. */
export interface KicadCore {
  detectKind(text: string): DesignKind | null;
  parse(text: string, kind?: KindHint): ParsedDesign;
  diff(before: string, after: string, kind?: KindHint): DiffResult;
  conflicts(base: string, ours: string, theirs: string, kind?: KindHint): Conflict[];
  bom(sheets: string[]): BomLine[];
  bomDiff(before: string[], after: string[]): BomChange[];
}

export interface RawBindings {
  detectKind(text: string): string | undefined;
  parse(text: string, kind: string): string;
  diff(before: string, after: string, kind: string): string;
  conflicts(base: string, ours: string, theirs: string, kind: string): string;
  bom(sheetsJson: string): string;
  bomDiff(beforeJson: string, afterJson: string): string;
}

export function wrapBindings(raw: RawBindings): KicadCore {
  return {
    detectKind: (text) => (raw.detectKind(text) as DesignKind | undefined) ?? null,
    parse: (text, kind = 'auto') => JSON.parse(raw.parse(text, kind)),
    diff: (before, after, kind = 'auto') => JSON.parse(raw.diff(before, after, kind)),
    conflicts: (base, ours, theirs, kind = 'auto') => JSON.parse(raw.conflicts(base, ours, theirs, kind)),
    bom: (sheets) => JSON.parse(raw.bom(JSON.stringify(sheets))),
    bomDiff: (before, after) => JSON.parse(raw.bomDiff(JSON.stringify(before), JSON.stringify(after))),
  };
}
