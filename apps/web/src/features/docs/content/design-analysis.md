# Design analysis

## Fab check

Open a `.kicad_pcb` file and click the **Fab check** tab. Jumper reads the board and shows:

- size, layer count and thickness
- number of parts, pads, nets, vias and zones
- the thinnest track, smallest via, smallest hole and smallest annular ring
- total track length and part density

It compares these with the standard limits of **JLCPCB, PCBWay, OSH Park and Eurocircuits**. Each fab shows *compatible* or a list of problems.

> [!NOTE]
> The limits are the fabs' published minimums, and fabs change them. Check the fab's own page before you order. Clearance between copper can't be measured from the file. Run DRC with the fab's rules for that.

You can pick your usual fabs under **Settings → Manufacturing & parts**.

## Changelog

Every commit and comparison has a **Design changes** panel. It lists parts added or removed, value changes (`R1: 10k → 4k7`), new and removed nets, and via and length changes.

You can get the same list from the API:

```
GET /api/repos/{owner}/{repo}/changelog?base=…&head=…
```

## Part policy

Under **Settings → Manufacturing & parts** you can list approved manufacturers, preferred parts and banned parts or footprints. Jumper checks each schematic's BOM against it using the `MPN` and `Manufacturer` fields. Banned patterns can use `*` and `?`.

## Firmware pin map

On a schematic, the **Firmware** tab turns the MCU's pin connections into code.

| Download       | Example                                                  |
| -------------- | -------------------------------------------------------- |
| `pins.h`       | `#define PIN_SPI_SCK 5`                                  |
| Zephyr overlay | `spi-sck-gpios = <&gpioa 5 GPIO_ACTIVE_HIGH>;`           |
| CSV            | For spreadsheets                                         |

It needs the netlist output, which is on by default. STM32 names (`PA5`) and nRF names (`P0.13`) are supported.

To see which pins changed between two revisions:

```
GET /api/repos/{owner}/{repo}/pinmap/diff?base=…&head=…
```
