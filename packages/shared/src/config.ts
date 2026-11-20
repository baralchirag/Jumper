// `.jumper.yml` project configuration, read from the repository root.
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** Fab houses Jumper can build a ready-to-upload order package for, plus a neutral layout. */
export const FAB_PACKAGE_FORMATS = ['jlcpcb', 'pcbway', 'oshpark', 'generic'] as const;
export type FabPackageFormat = (typeof FAB_PACKAGE_FORMATS)[number];
export const FAB_PACKAGE_LABELS: Record<FabPackageFormat, string> = { jlcpcb: 'JLCPCB', pcbway: 'PCBWay', oshpark: 'OSH Park', generic: 'Manufacturing' };

const failOn = z.enum(['error', 'warning', 'never']);
const severity = z.enum(['error', 'warning', 'ignore']);

export const jumperConfigSchema = z
  .object({
    /** Major KiCad version used to process the design (selects worker image). */
    kicad_version: z.union([z.string(), z.number()]).transform(String).optional(),
    /** Explicit `.kicad_pro` paths. Auto-detected when omitted. */
    projects: z.array(z.string()).max(32).optional(),
    checks: z
      .object({
        erc: z
          .object({ enabled: z.boolean().default(true), fail_on: failOn.default('error') })
          .prefault({}),
        drc: z
          .object({
            enabled: z.boolean().default(true),
            fail_on: failOn.default('error'),
            schematic_parity: z.boolean().default(true),
            /** Treat unconnected items as failures. */
            fail_on_unconnected: z.boolean().default(true),
          })
          .prefault({}),
        bom: z
          .object({ enabled: z.boolean().default(true), block_on_change: z.boolean().default(false) })
          .prefault({}),
      })
      .prefault({}),
    /** Per-rule severity overrides, keyed by KiCad violation type. */
    severity_overrides: z
      .object({
        erc: z.record(z.string(), severity).default({}),
        drc: z.record(z.string(), severity).default({}),
      })
      .prefault({}),
    outputs: z
      .object({
        svg: z.boolean().default(true),
        glb: z.boolean().default(true),
        /** STEP via OpenCascade (the kernel KiCad uses); also viewable in the browser. */
        step: z.boolean().default(true),
        gerbers: z.boolean().default(true),
        /** Ray-traced 3D images (top, bottom, isometric) from KiCad's own renderer. */
        render3d: z.boolean().default(true),
        /** Unset: `high` on the default branch (and manual re-runs), `basic` on other branches, which renders much faster. */
        render_quality: z.enum(['basic', 'high']).optional(),
        /** Schematic and board PDFs. */
        pdf: z.boolean().default(true),
        /** Pick-and-place files (KiCad CSV). */
        pos: z.boolean().default(true),
        netlist: z.boolean().default(true),
        ipc2581: z.boolean().default(false),
        odb: z.boolean().default(false),
        /**
         * Order packages to build: one zip per fab house, each in that fab's own layout. A single name or a list,
         * e.g. `fab_package: [jlcpcb, pcbway, oshpark]`. `none` builds nothing.
         */
        fab_package: z
          .union([z.enum(FAB_PACKAGE_FORMATS), z.literal('none'), z.array(z.enum(FAB_PACKAGE_FORMATS)).max(FAB_PACKAGE_FORMATS.length)])
          .default('jlcpcb')
          .transform((v): FabPackageFormat[] => (v === 'none' ? [] : [...new Set(Array.isArray(v) ? v : [v])])),
      })
      .prefault({}),
    /** Checks that must succeed before a pull request can be merged. */
  })
  .prefault({});

export type JumperConfig = z.output<typeof jumperConfigSchema>;

export const DEFAULT_CONFIG: JumperConfig = jumperConfigSchema.parse({});

export function parseJumperConfig(text: string | null | undefined): {
  config: JumperConfig;
  error: string | null;
} {
  if (!text || !text.trim()) return { config: DEFAULT_CONFIG, error: null };
  try {
    const raw = parseYaml(text, { maxAliasCount: 50 });
    const result = jumperConfigSchema.safeParse(raw ?? {});
    if (!result.success) {
      return { config: DEFAULT_CONFIG, error: z.prettifyError(result.error) };
    }
    return { config: result.data, error: null };
  } catch (e) {
    return { config: DEFAULT_CONFIG, error: `Invalid YAML: ${(e as Error).message}` };
  }
}
