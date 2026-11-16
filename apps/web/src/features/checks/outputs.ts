import { Box as BoxIcon, Cpu, Factory, FileCode2, FileText, Image, Layers, ListChecks, Network, Package, type LucideIcon } from 'lucide-react';
import { FAB_PACKAGE_LABELS, type ArtifactInfo, type ArtifactKind, type FabPackageFormat } from '@jumper/shared';

export type OutputGroup = 'Manufacturing' | 'Documents' | '3D' | 'Data' | 'Reports';

export interface OutputKind {
  label: string;
  icon: LucideIcon;
  group: OutputGroup;
  order: number;
  hint: string;
}

/** Artifact kinds shown as outputs (layer SVGs and thumbnails live in the KiCad render tab). */
export const OUTPUT_KINDS: Partial<Record<ArtifactKind, OutputKind>> = {
  fab_package: { label: 'Manufacturing package', icon: Factory, group: 'Manufacturing', order: 0, hint: 'Gerbers, drill, BOM and placement in one upload' },
  gerbers: { label: 'Gerbers + drill', icon: Layers, group: 'Manufacturing', order: 1, hint: 'Fabrication layers and Excellon drill files' },
  pos: { label: 'Pick-and-place', icon: Cpu, group: 'Manufacturing', order: 2, hint: 'Component positions for assembly' },
  bom: { label: 'Bill of materials', icon: Package, group: 'Manufacturing', order: 3, hint: 'Grouped parts list' },
  pdf: { label: 'PDF', icon: FileText, group: 'Documents', order: 4, hint: 'Printable schematic and board plots' },
  render3d: { label: 'Ray-traced render', icon: Image, group: '3D', order: 5, hint: "KiCad's 3D renderer" },
  step: { label: 'STEP model', icon: BoxIcon, group: '3D', order: 6, hint: 'Mechanical CAD model (OpenCascade)' },
  glb: { label: 'GLB model', icon: BoxIcon, group: '3D', order: 7, hint: 'Web 3D model with component bodies' },
  netlist: { label: 'Netlist', icon: Network, group: 'Data', order: 8, hint: 'KiCad S-expression netlist' },
  ipc2581: { label: 'IPC-2581', icon: FileCode2, group: 'Data', order: 9, hint: 'Intelligent manufacturing data' },
  odb: { label: 'ODB++', icon: FileCode2, group: 'Data', order: 10, hint: 'Intelligent manufacturing data' },
  erc_report: { label: 'ERC report', icon: ListChecks, group: 'Reports', order: 11, hint: 'Electrical rules check (JSON)' },
  drc_report: { label: 'DRC report', icon: ListChecks, group: 'Reports', order: 12, hint: 'Design rules check (JSON)' },
};

export const OUTPUT_GROUPS: OutputGroup[] = ['Manufacturing', 'Documents', '3D', 'Data', 'Reports'];

export function isOutput(a: ArtifactInfo): boolean {
  return Boolean(OUTPUT_KINDS[a.kind]);
}

export function sortOutputs(list: ArtifactInfo[]): ArtifactInfo[] {
  return [...list].sort((a, b) => (OUTPUT_KINDS[a.kind]?.order ?? 99) - (OUTPUT_KINDS[b.kind]?.order ?? 99) || Number(a.meta.order ?? 0) - Number(b.meta.order ?? 0) || a.name.localeCompare(b.name));
}

/** Human title for one output ("Schematic PDF", "Top render", …). */
export function outputTitle(a: ArtifactInfo): string {
  const k = OUTPUT_KINDS[a.kind];
  if (a.kind === 'pdf') return a.meta.source === 'board' ? 'Board PDF' : a.meta.source === 'schematic' ? 'Schematic PDF' : a.name;
  if (a.kind === 'render3d') return `${String(a.meta.view ?? a.name.replace(/\.png$/, '')).replace('-', ' ')} render`.replace(/^\w/, (c) => c.toUpperCase());
  if (a.kind === 'bom') return a.name.endsWith('.csv') ? 'BOM (CSV)' : 'BOM (JSON)';
  if (a.kind === 'fab_package') return `${FAB_PACKAGE_LABELS[a.meta.format as FabPackageFormat] ?? 'Manufacturing'} package`;
  return k?.label ?? a.name;
}

export function downloadUrl(a: ArtifactInfo): string {
  return `${a.url}?download=true`;
}

export type ViewerKind = 'pdf' | 'image' | '3d-glb' | '3d-step' | 'csv' | 'json' | 'text' | 'archive' | 'none';

export function viewerKind(a: ArtifactInfo): ViewerKind {
  const n = a.name.toLowerCase();
  if (n.endsWith('.pdf')) return 'pdf';
  if (/\.(png|jpe?g|svg|webp)$/.test(n)) return 'image';
  if (n.endsWith('.glb')) return '3d-glb';
  if (/\.(step|stp)$/.test(n)) return '3d-step';
  if (n.endsWith('.csv')) return 'csv';
  if (n.endsWith('.json')) return 'json';
  if (/\.(net|xml|txt|drl|gbr|rpt)$/.test(n)) return 'text';
  if (n.endsWith('.zip')) return 'archive';
  return 'none';
}
