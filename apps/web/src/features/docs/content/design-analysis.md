# Design analysis

## Board statistics & fab check

Open a `.kicad_pcb` and choose the **Fab check** tab. Jumper measures the board directly from the file:

* size, copper layer count and thickness
* component, pad, net, via and zone counts
* narrowest track, smallest via, smallest hole and smallest annular ring
* total routed length and component density

It then compares those numbers with the standard-service limits of **JLCPCB, PCBWay, OSH Park and Eurocircuits**. Each fab shows *compatible* or the list of problems, split into errors (the fab will reject the board) and warnings.

> [!NOTE]
> Limits are conservative published minimums and fabs change them. Always confirm against the fab's current capability page. Copper-to-copper **clearance** cannot be measured from the file alone; run DRC with the fab's rules.

Choose your usual fabs under Settings → **Manufacturing & parts** to compare against only those.

## Changelog

Every pull request has a **Design changes** panel, and the API exposes the same summary for any two revisions: `GET /api/repos/{owner}/{repo}/changelog?base=…&head=…`. It is generated from the semantic diff — parts added or removed, value edits (`R1: 10k → 4k7`), new and removed nets, via and length changes — so release notes write themselves.

## Part policy

Define approved manufacturers, preferred part numbers and banned parts or footprints in Settings → **Manufacturing & parts**. `GET …/part-policy?path=<schematic>` checks a schematic's BOM against it and reports violations, using the `MPN` and `Manufacturer` fields of each symbol. Banned patterns accept `*` and `?` wildcards and match the manufacturer part number or the value.

## Firmware pin map

On a schematic, the **Firmware** tab turns the MCU's pin connections into code:

| Download | Use |
|---|---|
| `pins.h` | `#define PIN_SPI_SCK 5` per connected GPIO |
| Zephyr overlay | `zephyr,user` node with `spi-sck-gpios = <&gpioa 5 GPIO_ACTIVE_HIGH>;` |
| CSV | spreadsheets and review |

It reads the netlist produced by the checks (enable `netlist: true` in [`.jumper.yml`](/docs/jumper-yml)). STM32 names (`PA5`) and nRF names (`P0.13`) are understood. Between two revisions, `GET …/pinmap/diff?base=…&head=…` lists every pin whose net changed, so you notice when a schematic edit breaks the firmware.
