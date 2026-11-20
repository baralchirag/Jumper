# `.jumper.yml` reference

`.jumper.yml` is an optional file at the root of a repository. It chooses which checks run on each push, how strict they are, and which manufacturing outputs are generated. **Every key is optional.** A repository without the file gets the defaults below.

The file is read from the commit being checked, so a change to `.jumper.yml` applies to that commit and everything after it. You can try a new configuration on a branch first.

## Complete example

```yaml
kicad_version: 9

projects:
  - hardware/main/main.kicad_pro

checks:
  erc:
    enabled: true
    fail_on: error
  drc:
    enabled: true
    fail_on: error
    schematic_parity: true
    fail_on_unconnected: true
  bom:
    enabled: true
    block_on_change: false

severity_overrides:
  erc:
    pin_not_connected: error
  drc:
    silk_overlap: ignore
    lib_footprint_mismatch: warning

outputs:
  svg: true
  glb: true
  step: true
  gerbers: true
  render3d: true
  render_quality: high      # optional; see below
  pdf: true
  pos: true
  netlist: true
  ipc2581: false
  odb: false
  fab_package: jlcpcb
```

## Top level

| Key | Type | Default | Description |
|---|---|---|---|
| `kicad_version` | number or string | none | The KiCad major version the project targets, e.g. `9`. Informational for now: checks always run with the instance's KiCad, whose version is shown on each result. |
| `projects` | list of paths (up to 32) | auto | `.kicad_pro` files to analyse. When omitted, every `*.kicad_pro` in the repository is used, plus boards committed without a project file. Set it to skip archived revisions or library test projects. |
| `checks` | map | see below | Which checks run and when they fail. |
| `severity_overrides` | map | `{}` | Change the severity of individual KiCad rules. |
| `outputs` | map | see below | Files generated for every commit. |

## `checks`

### `checks.erc`

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Run `kicad-cli sch erc` on every schematic. |
| `fail_on` | `error` \| `warning` \| `never` | `error` | The lowest severity that fails the check. With `never` the check reports violations but always passes. |

### `checks.drc`

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Run `kicad-cli pcb drc` on every board. |
| `fail_on` | `error` \| `warning` \| `never` | `error` | As for ERC. |
| `schematic_parity` | boolean | `true` | Also compare the board with the schematic, so footprints missing from the board, or extra ones on it, are reported. |
| `fail_on_unconnected` | boolean | `true` | Count unrouted connections (ratsnest lines) as errors. Turn off while a board is still being routed. |

### `checks.bom`

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Build the bill of materials, group identical parts, and diff it against the parent commit. |
| `block_on_change` | boolean | `false` | Fail the BOM check whenever the BOM differs from the parent commit. Use it to make every part change stand out in the check results. |

## `severity_overrides`

Re-grade individual KiCad rules without editing the KiCad project. Keys are KiCad violation types, exactly as shown in the **Checks** tab (for example `silk_overlap`, `pin_not_connected`, `lib_footprint_mismatch`). Values are `error`, `warning` or `ignore`.

```yaml
severity_overrides:
  drc:
    silk_overlap: ignore          # cosmetic on this board
    courtyards_overlap: error     # never allow it
  erc:
    power_pin_not_driven: warning
```

Overrides are applied before `fail_on`, so moving a rule to `warning` keeps it visible without failing a check that fails only on errors.

## `outputs`

| Key | Type | Default | What you get |
|---|---|---|---|
| `svg` | boolean | `true` | Schematic sheets and one SVG per board layer: the **KiCad render** tab. |
| `glb` | boolean | `true` | 3D model with component bodies for the **3D** tab. |
| `step` | boolean | `true` | STEP export through OpenCascade (the kernel KiCad uses), viewable in the browser. |
| `gerbers` | boolean | `true` | Gerber and drill files, zipped. |
| `render3d` | boolean | `true` | Ray-traced top, bottom and isometric images from KiCad's own 3D renderer. |
| `render_quality` | `basic` \| `high` | `high` on the default branch, `basic` elsewhere | `basic` is much faster; `high` adds shadows and ambient occlusion. Set it to use one quality everywhere. |
| `pdf` | boolean | `true` | Schematic PDF (all sheets) and board PDF. |
| `pos` | boolean | `true` | Pick-and-place (component position) CSV. |
| `netlist` | boolean | `true` | KiCad netlist. Needed by the **Firmware** pin-map tab. |
| `ipc2581` | boolean | `false` | IPC-2581 XML, for manufacturers that accept it. |
| `odb` | boolean | `false` | ODB++ archive. |
| `fab_package` | `jlcpcb` \| `generic` \| `none` | `jlcpcb` | One zip ready to order: Gerbers, drill, BOM and placement. `jlcpcb` uses JLCPCB's BOM and CPL column layout; `generic` uses KiCad's own. |

Turning off outputs you do not use makes checks finish sooner.

## Check results

Each check ends in one of these states:

| Result | Meaning |
|---|---|
| `success` | Clean. |
| `neutral` | Violations below the `fail_on` threshold, or a render that partly failed. |
| `skipped` | Disabled, nothing to check (for example no schematic), or replaced by a newer push to the same branch before it started. |
| `failure` | Violations at or above `fail_on`. |
| `timed_out` | KiCad took too long. |
| `cancelled` | Stopped before it finished. Push again or re-run it. |

## 3D models and libraries

Footprints often point at 3D models through library variables from another machine. Before exporting, Jumper matches these against its own KiCad library:

- old variables such as `${KICAD6_3DMODEL_DIR}` and the `:ALIAS:` syntax;
- `.wrl` files (KiCad 8 and later ship STEP only);
- absolute paths from someone else's computer.

Models stored in the repository and referenced with `${KIPRJMOD}` are used as they are. **Commit your custom 3D models next to the design.** Anything that still cannot be found is listed on the Render check.

## Mistakes in the file

An invalid `.jumper.yml` never stops analysis. Jumper uses the defaults and reports the problem on the Render check (or on every check when no project is found), naming the key and the reason:

```text
Invalid .jumper.yml: ✖ Invalid option: expected one of "error"|"warning"|"never"
  → at checks.drc.fail_on
```
