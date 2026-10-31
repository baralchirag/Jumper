// `.pcbhub.yml` project configuration, read from the repository root.
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const failOn = z.enum(['error', 'warning', 'never']);
const severity = z.enum(['error', 'warning', 'ignore']);

export const pcbhubConfigSchema = z
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
        step: z.boolean().default(false),
        gerbers: z.boolean().default(true),
      })
      .prefault({}),
    /** Checks that must succeed before a pull request can be merged. */
    required_checks: z.array(z.string()).default(['ERC', 'DRC']),
  })
  .prefault({});

export type PcbhubConfig = z.output<typeof pcbhubConfigSchema>;

export const DEFAULT_CONFIG: PcbhubConfig = pcbhubConfigSchema.parse({});

export function parsePcbhubConfig(text: string | null | undefined): {
  config: PcbhubConfig;
  error: string | null;
} {
  if (!text || !text.trim()) return { config: DEFAULT_CONFIG, error: null };
  try {
    const raw = parseYaml(text, { maxAliasCount: 50 });
    const result = pcbhubConfigSchema.safeParse(raw ?? {});
    if (!result.success) {
      return { config: DEFAULT_CONFIG, error: z.prettifyError(result.error) };
    }
    return { config: result.data, error: null };
  } catch (e) {
    return { config: DEFAULT_CONFIG, error: `Invalid YAML: ${(e as Error).message}` };
  }
}
