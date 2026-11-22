# `.jumper.yml`

`.jumper.yml` is an optional file at the root of your repository. It controls which checks run and which files are made. Every key is optional. Without the file you get the defaults below.

The file is read from the commit being checked. So you can try a new config on a branch first.

## Example

```yaml
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
  drc:
    silk_overlap: ignore

outputs:
  gerbers: true
  step: true
  render3d: true
  render_quality: high
  fab_package: jlcpcb
```

## Top level

| Key                  | Default | What it does |
| -------------------- | ------- | ------------ |
| `kicad_version`      | none    | The KiCad version you use, like `9`. Only for information. |
| `projects`           | auto    | `.kicad_pro` files to check. By default every one in the repository. |
| `checks`             |         | Which checks run and when they fail. |
| `severity_overrides` | `{}`    | Change the level of single KiCad rules. |
| `outputs`            |         | Files made for each commit. |

## `checks`

**`checks.erc`** and **`checks.drc`**

| Key        | Default | What it does |
| ---------- | ------- | ------------ |
| `enabled`  | `true`  | Run the check. |
| `fail_on`  | `error` | `error`, `warning` or `never`. The lowest level that fails the check. |

DRC also has:

| Key                   | Default | What it does |
| --------------------- | ------- | ------------ |
| `schematic_parity`    | `true`  | Compare the board with the schematic. |
| `fail_on_unconnected` | `true`  | Count unrouted connections as errors. Turn off while routing. |

**`checks.bom`**

| Key               | Default | What it does |
| ----------------- | ------- | ------------ |
| `enabled`         | `true`  | Build the BOM and compare it with the last commit. |
| `block_on_change` | `false` | Fail whenever the BOM changes. |

## `severity_overrides`

Change one KiCad rule without editing the project. Use the rule name from the **Checks** tab. Values are `error`, `warning` or `ignore`.

```yaml
severity_overrides:
  drc:
    silk_overlap: ignore
    courtyards_overlap: error
  erc:
    power_pin_not_driven: warning
```

## `outputs`

| Key              | Default | What you get |
| ---------------- | ------- | ------------ |
| `svg`            | `true`  | Schematic sheets and board layers as SVG |
| `glb`            | `true`  | 3D model for the 3D viewer |
| `step`           | `true`  | STEP file |
| `gerbers`        | `true`  | Gerber and drill files |
| `render3d`       | `true`  | Top, bottom and angled 3D images |
| `render_quality` | `high` on the default branch, `basic` elsewhere | `basic` is faster |
| `pdf`            | `true`  | Schematic and board PDF |
| `pos`            | `true`  | Pick-and-place CSV |
| `netlist`        | `true`  | Netlist, used by the Firmware tab |
| `ipc2581`        | `false` | IPC-2581 XML |
| `odb`            | `false` | ODB++ archive |
| `fab_package`    | `jlcpcb` | `jlcpcb`, `generic` or `none`. One zip with Gerbers, drill, BOM and placement. |

Turning off outputs you don't need makes checks faster.

## Check results

| Result      | Meaning |
| ----------- | ------- |
| `success`   | No problems. |
| `neutral`   | Problems below `fail_on`. |
| `skipped`   | Turned off, nothing to check, or replaced by a newer push. |
| `failure`   | Problems at or above `fail_on`. |
| `timed_out` | KiCad took too long. |
| `cancelled` | Stopped before it finished. |

## 3D models

Footprints often point to 3D models with paths from someone else's computer. Jumper tries to match them with its own KiCad library. This covers old variables like `${KICAD6_3DMODEL_DIR}`, `.wrl` files and absolute paths.

Commit your custom 3D models and use `${KIPRJMOD}` paths. Anything still missing is listed on the Render check.

## Mistakes in the file

A broken `.jumper.yml` doesn't stop the checks. Jumper uses the defaults and shows the error on the Render check:

```text
Invalid .jumper.yml: ✖ Invalid option: expected one of "error"|"warning"|"never"
  → at checks.drc.fail_on
```
