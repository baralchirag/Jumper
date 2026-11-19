#!/usr/bin/env python3
"""Generate the starter-template KiCad projects offered when creating a repository.

Every symbol and footprint comes from KiCad's own libraries (installed with KiCad 9), so the templates are real,
editable KiCad projects rather than drawings. For each template the script:

  1. writes a schematic: parts placed on a grid, every pin tied to its net with a power symbol or a net label
     (no wires to untangle), unused pins marked no-connect, PWR_FLAGs where nothing drives a supply;
  2. asks kicad-cli for the netlist of that schematic;
  3. builds a board with pcbnew: an outline, every footprint placed without overlaps, every pad on its net;
  4. checks the result with kicad-cli: ERC must be clean, DRC must have no violations and no schematic-parity
     issues (unrouted connections are expected: routing is the user's job);
  5. writes apps/api/src/modules/repos/templates.gen.ts.

Run from the repository root:  python3 scripts/templates/build.py
Needs kicad-cli and the pcbnew Python module (KiCad 9).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import uuid as uuidlib
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SYMBOLS = Path(os.environ.get('KICAD_SYMBOL_DIR', '/usr/share/kicad/symbols'))
FOOTPRINTS = Path(os.environ.get('KICAD_FOOTPRINT_DIR', '/usr/share/kicad/footprints'))
OUT = ROOT / 'apps/api/src/modules/repos/templates.gen.ts'
GRID = 2.54
# Deterministic UUIDs so regenerating without changes gives byte-identical files.
NS = uuidlib.UUID('9c1d7f6e-0b5a-4f0e-8a51-6a756d706572')


def uid(*parts: str) -> str:
    return str(uuidlib.uuid5(NS, '/'.join(parts)))


# ---------------------------------------------------------------- s-expressions

def tokenize(s: str) -> list[str]:
    return re.findall(r'"(?:[^"\\]|\\.)*"|\(|\)|[^\s()"]+', s)


def parse(s: str):
    toks = tokenize(s)
    pos = 0

    def rec():
        nonlocal pos
        t = toks[pos]
        pos += 1
        if t != '(':
            return t
        out = []
        while toks[pos] != ')':
            out.append(rec())
        pos += 1
        return out

    return rec()


def dump(x, indent: int = 0) -> str:
    if not isinstance(x, list):
        return x
    if all(not isinstance(c, list) for c in x):
        return '(' + ' '.join(x) + ')'
    pad = '\t' * (indent + 1)
    head = []
    rest = list(x)
    while rest and not isinstance(rest[0], list):
        head.append(rest.pop(0))
    return '(' + ' '.join(head) + ''.join('\n' + pad + dump(c, indent + 1) for c in rest) + '\n' + '\t' * indent + ')'


def q(s: str) -> str:
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'


def unq(s: str) -> str:
    return s[1:-1].replace('\\"', '"').replace('\\\\', '\\') if s.startswith('"') else s


def child(node, key):
    return next((c for c in node if isinstance(c, list) and c and c[0] == key), None)


def children(node, key):
    return [c for c in node if isinstance(c, list) and c and c[0] == key]


# ---------------------------------------------------------------- library symbols

_lib_cache: dict[str, dict[str, list]] = {}


def library(lib: str) -> dict[str, list]:
    if lib not in _lib_cache:
        tree = parse((SYMBOLS / f'{lib}.kicad_sym').read_text())
        _lib_cache[lib] = {unq(c[1]): c for c in children(tree, 'symbol')}
    return _lib_cache[lib]


@dataclass
class Pin:
    number: str
    name: str
    type: str
    x: float  # library coordinates, Y up
    y: float
    angle: float


@dataclass
class LibSymbol:
    lib_id: str
    tree: list  # flattened, ready for the schematic's lib_symbols
    pins: list[Pin]
    footprint: str
    power: bool


def flatten(lib_id: str) -> LibSymbol:
    """Resolve `extends` the way KiCad does when it embeds a symbol in a schematic."""
    lib, name = lib_id.split(':')
    syms = library(lib)
    own = syms[name]
    ext = child(own, 'extends')
    base = syms[unq(ext[1])] if ext else own
    base_name = unq(base[1])
    out = ['symbol', q(lib_id)]
    for c in base[2:]:
        if not isinstance(c, list):
            out.append(c)
        elif c[0] == 'property':
            continue
        elif c[0] == 'symbol':
            sub = list(c)
            sub[1] = q(unq(sub[1]).replace(base_name, name, 1))
            out.append(sub)
        elif c[0] != 'extends':
            out.append(c)
    # Properties (and flags) come from the derived symbol when there is one.
    props = children(own, 'property') or children(base, 'property')
    idx = next(i for i, c in enumerate(out) if isinstance(c, list) and c[0] == 'symbol')
    out[idx:idx] = props
    for flag in ('power', 'in_bom', 'on_board', 'exclude_from_sim', 'pin_numbers', 'pin_names'):
        o = child(own, flag)
        if o is not None and ext:
            out = [c for c in out if not (isinstance(c, list) and c[0] == flag)]
            out.insert(2, o)
    pins = []
    for unit in children(base, 'symbol'):
        m = re.search(r'_(\d+)_(\d+)$', unq(unit[1]))
        if m and m.group(2) not in ('0', '1'):
            continue  # alternate body style
        for p in children(unit, 'pin'):
            at = child(p, 'at')
            pins.append(Pin(unq(child(p, 'number')[1]), unq(child(p, 'name')[1]), p[1], float(at[1]), float(at[2]), float(at[3]) if len(at) > 3 else 0.0))
    fp = next((unq(c[2]) for c in props if unq(c[1]) == 'Footprint'), '')
    return LibSymbol(lib_id, out, pins, fp, child(out, 'power') is not None)


def prop_value(sym: LibSymbol, key: str) -> str:
    return next((unq(c[2]) for c in children(sym.tree, 'property') if unq(c[1]) == key), '')


# ---------------------------------------------------------------- template description

POWER_NETS = {'+3V3': 'power:+3V3', 'GND': 'power:GND', 'VBUS': 'power:VBUS', '+1V1': 'power:+1V1'}
# Direction (library degrees) the body of each power symbol points: GND hangs down, supplies point up.
POWER_BODY = {'power:GND': 270}


@dataclass
class Part:
    ref: str
    lib_id: str
    value: str
    footprint: str = ''
    nets: dict[str, str] = field(default_factory=dict)  # pin number -> net
    at: tuple[float, float] = (0, 0)  # schematic position in grid units
    description: str = ''


@dataclass
class Template:
    id: str
    title: str
    comment: str
    parts: list[Part]
    board: tuple[float, float]  # mm


def r(ref, value, a, b, at, fp='Resistor_SMD:R_0603_1608Metric'):
    return Part(ref, 'Device:R', value, fp, {'1': a, '2': b}, at)


def c(ref, value, a, b, at, fp='Capacitor_SMD:C_0603_1608Metric'):
    return Part(ref, 'Device:C', value, fp, {'1': a, '2': b}, at)


def usb_c(at):
    return Part(
        'J1', 'Connector:USB_C_Receptacle_USB2.0_16P', 'USB_C', 'Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal',
        {'A1': 'GND', 'A12': 'GND', 'B1': 'GND', 'B12': 'GND', 'S1': 'GND', 'A4': 'VBUS', 'A9': 'VBUS', 'B4': 'VBUS', 'B9': 'VBUS',
         'A5': 'CC1', 'B5': 'CC2', 'A7': 'USB_D-', 'B7': 'USB_D-', 'A6': 'USB_D+', 'B6': 'USB_D+'},
        at,
    )


def power_block(x, y):
    """USB-C, CC pull-downs, a 3.3 V LDO with its capacitors and a power LED."""
    return [
        usb_c((x, y)),
        r('R1', '5.1k', 'CC1', 'GND', (x + 10, y + 6)),
        r('R2', '5.1k', 'CC2', 'GND', (x + 14, y + 6)),
        Part('U2', 'Regulator_Linear:AMS1117-3.3', 'AMS1117-3.3', '', {'3': 'VBUS', '1': 'GND', '2': '+3V3'}, (x, y + 22)),
        c('C1', '10u', 'VBUS', 'GND', (x - 8, y + 22), 'Capacitor_SMD:C_0805_2012Metric'),
        c('C2', '22u', '+3V3', 'GND', (x + 8, y + 22), 'Capacitor_SMD:C_0805_2012Metric'),
        r('R3', '1k', '+3V3', 'LED_A', (x + 14, y + 22)),
        Part('D1', 'Device:LED', 'Green', 'LED_SMD:LED_0603_1608Metric', {'1': 'GND', '2': 'LED_A'}, (x + 18, y + 22)),
    ]


def button(ref, net, at):
    return Part(ref, 'Switch:SW_Push', 'SW_Push', 'Button_Switch_SMD:SW_SPST_TL3342', {'1': net, '2': 'GND'}, at)


def header(ref, nets, at):
    n = len(nets)
    return Part(ref, f'Connector_Generic:Conn_01x{n:02d}', f'Conn_01x{n:02d}', f'Connector_PinHeader_2.54mm:PinHeader_1x{n:02d}_P2.54mm_Vertical', {str(i + 1): v for i, v in enumerate(nets)}, at)


def esp32() -> Template:
    io = ['IO1', 'IO2', 'IO4', 'IO5', 'IO6', 'IO7', 'IO15', 'IO16']
    pins = {'IO1': '39', 'IO2': '38', 'IO4': '4', 'IO5': '5', 'IO6': '6', 'IO7': '7', 'IO15': '8', 'IO16': '9'}
    mcu = Part('U1', 'RF_Module:ESP32-S3-WROOM-1', 'ESP32-S3-WROOM-1', '', {'2': '+3V3', '1': 'GND', '40': 'GND', '41': 'GND', '3': 'EN', '27': 'IO0', '13': 'USB_D-', '14': 'USB_D+', '37': 'TXD0', '36': 'RXD0', **{pins[k]: k for k in io}}, (60, 40))
    return Template('esp32-s3', 'ESP32-S3 board', 'ESP32-S3-WROOM-1 with USB-C, 3.3 V LDO, EN and BOOT buttons.', [
        *power_block(14, 16),
        mcu,
        c('C3', '10u', '+3V3', 'GND', (40, 20), 'Capacitor_SMD:C_0805_2012Metric'),
        c('C4', '100n', '+3V3', 'GND', (44, 20)),
        r('R4', '10k', '+3V3', 'EN', (88, 16)),
        c('C5', '1u', 'EN', 'GND', (92, 16)),
        button('SW1', 'EN', (96, 16)),
        r('R5', '10k', '+3V3', 'IO0', (88, 30)),
        button('SW2', 'IO0', (96, 30)),
        header('J2', ['+3V3', 'GND', 'TXD0', 'RXD0', *io], (100, 48)),
    ], (50, 40))


def stm32() -> Template:
    mcu = Part('U1', 'MCU_ST_STM32F1:STM32F103C8Tx', 'STM32F103C8Tx', '', {
        '1': '+3V3', '24': '+3V3', '36': '+3V3', '48': '+3V3', '9': '+3V3', '23': 'GND', '35': 'GND', '47': 'GND', '8': 'GND',
        '7': 'NRST', '44': 'BOOT0', '5': 'HSE_IN', '6': 'HSE_OUT', '32': 'USB_DM', '33': 'USB_DP', '34': 'SWDIO', '37': 'SWCLK',
        '30': 'USART1_TX', '31': 'USART1_RX', '2': 'LED',
    }, (64, 44))
    return Template('stm32', 'STM32 board', 'STM32F103C8T6 with 8 MHz crystal, SWD header, USB-C and 3.3 V LDO.', [
        *power_block(14, 16),
        mcu,
        *[c(f'C{3 + i}', '100n', '+3V3', 'GND', (36 + 4 * i, 64)) for i in range(4)],
        c('C7', '1u', '+3V3', 'GND', (52, 64)),
        Part('Y1', 'Device:Crystal_GND24', '8MHz', 'Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm', {'1': 'HSE_IN', '3': 'HSE_OUT', '2': 'GND', '4': 'GND'}, (30, 40)),
        c('C8', '20p', 'HSE_IN', 'GND', (24, 46)),
        c('C9', '20p', 'HSE_OUT', 'GND', (36, 46)),
        r('R4', '10k', 'BOOT0', 'GND', (92, 14)),
        r('R5', '1.5k', '+3V3', 'USB_DP', (96, 14)),
        r('R6', '22', 'USB_D-', 'USB_DM', (100, 22)),
        r('R7', '22', 'USB_D+', 'USB_DP', (104, 22)),
        c('C10', '100n', 'NRST', 'GND', (100, 34)),
        button('SW1', 'NRST', (104, 34)),
        r('R8', '1k', 'LED', 'LED2_A', (100, 46)),
        Part('D2', 'Device:LED', 'Blue', 'LED_SMD:LED_0603_1608Metric', {'1': 'LED2_A', '2': '+3V3'}, (104, 46)),
        header('J2', ['+3V3', 'SWDIO', 'SWCLK', 'GND'], (110, 60)),
        header('J3', ['+3V3', 'GND', 'USART1_TX', 'USART1_RX'], (118, 60)),
    ], (50, 40))


def rp2040() -> Template:
    mcu = Part('U1', 'MCU_RaspberryPi:RP2040', 'RP2040', '', {
        '1': '+3V3', '10': '+3V3', '22': '+3V3', '33': '+3V3', '42': '+3V3', '49': '+3V3', '43': '+3V3', '48': '+3V3', '44': '+3V3',
        '45': '+1V1', '23': '+1V1', '50': '+1V1', '57': 'GND', '19': 'GND',
        '26': 'RUN', '46': 'RP_DM', '47': 'RP_DP', '56': 'QSPI_SS', '52': 'QSPI_SCLK', '53': 'QSPI_SD0', '55': 'QSPI_SD1', '54': 'QSPI_SD2', '51': 'QSPI_SD3',
        '20': 'XIN', '21': 'XOUT', '24': 'SWCLK', '25': 'SWDIO', '2': 'GPIO0', '3': 'GPIO1', '4': 'GPIO2', '5': 'GPIO3', '27': 'GPIO16', '37': 'GPIO25',
    }, (64, 48))
    return Template('rp2040', 'RP2040 board', 'RP2040 with 16 MB QSPI flash, 12 MHz crystal, USB-C and 3.3 V LDO.', [
        *power_block(14, 16),
        mcu,
        *[c(f'C{3 + i}', '100n', '+3V3', 'GND', (34 + 4 * i, 76)) for i in range(6)],
        c('C9', '1u', '+1V1', 'GND', (58, 76)),
        c('C10', '100n', '+1V1', 'GND', (62, 76)),
        Part('U3', 'Memory_Flash:W25Q128JVS', 'W25Q128JVS', '', {'1': 'QSPI_SS', '6': 'QSPI_SCLK', '5': 'QSPI_SD0', '2': 'QSPI_SD1', '3': 'QSPI_SD2', '7': 'QSPI_SD3', '8': '+3V3', '4': 'GND'}, (100, 20)),
        c('C11', '100n', '+3V3', 'GND', (112, 14)),
        r('R4', '1k', 'QSPI_SS', 'BOOTSEL', (92, 34)),
        button('SW1', 'BOOTSEL', (98, 34)),
        r('R5', '10k', '+3V3', 'RUN', (92, 44)),
        button('SW2', 'RUN', (98, 44)),
        Part('Y1', 'Device:Crystal_GND24', '12MHz', 'Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm', {'1': 'XIN', '3': 'XOUT_R', '2': 'GND', '4': 'GND'}, (30, 52)),
        r('R6', '1k', 'XOUT', 'XOUT_R', (36, 58)),
        c('C12', '15p', 'XIN', 'GND', (24, 58)),
        c('C13', '15p', 'XOUT_R', 'GND', (30, 62)),
        r('R7', '27', 'USB_D-', 'RP_DM', (104, 54)),
        r('R8', '27', 'USB_D+', 'RP_DP', (108, 54)),
        header('J2', ['+3V3', 'SWCLK', 'SWDIO', 'GND'], (110, 66)),
        header('J3', ['+3V3', 'GND', 'GPIO0', 'GPIO1', 'GPIO2', 'GPIO3', 'GPIO16', 'GPIO25'], (118, 66)),
    ], (50, 40))


# ---------------------------------------------------------------- schematic

FONT = '(effects (font (size 1.27 1.27)))'


def fmt(v: float) -> str:
    s = f'{v:.4f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def outward(angle: float) -> int:
    return int((angle + 180) % 360)


def label_sexpr(net: str, x: float, y: float, d: int, key: str) -> str:
    # Text runs away from the pin: right/up use left justification, left/down are rotated and right-justified.
    ang, just = {0: (0, 'left'), 90: (90, 'left'), 180: (180, 'right'), 270: (270, 'right')}[d]
    return f'(label {q(net)} (at {fmt(x)} {fmt(y)} {ang}) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify {just} bottom)) (uuid {q(uid(key))}))'


def symbol_instance(t: Template, lib: LibSymbol, ref: str, value: str, footprint: str, x: float, y: float, rot: int, key: str, hidden_ref: bool, pins: list[str], description: str = '') -> str:
    # Reference above, value below the body (body extent estimated from the pins).
    ys = [p.y for p in lib.pins] or [0]
    top, bottom = y - max(ys) - 2.54, y - min(ys) + 2.54
    props = [
        f'(property "Reference" {q(ref)} (at {fmt(x)} {fmt(top)} 0) (effects (font (size 1.27 1.27)){" (hide yes)" if hidden_ref else ""}))',
        f'(property "Value" {q(value)} (at {fmt(x)} {fmt(bottom if not lib.power else y + (3.81 if POWER_BODY.get(lib.lib_id) == 270 and rot == 0 else -3.81))} 0) {FONT})',
        f'(property "Footprint" {q(footprint)} (at {fmt(x)} {fmt(y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))',
        f'(property "Datasheet" {q(prop_value(lib, "Datasheet") or "~")} (at {fmt(x)} {fmt(y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))',
        f'(property "Description" {q(description or prop_value(lib, "Description"))} (at {fmt(x)} {fmt(y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))',
    ]
    pin_lines = ' '.join(f'(pin {q(n)} (uuid {q(uid(key, "pin", n))}))' for n in pins)
    return (
        f'(symbol (lib_id {q(lib.lib_id)}) (at {fmt(x)} {fmt(y)} {rot}) (unit 1) (exclude_from_sim no) (in_bom {"no" if lib.power else "yes"}) (on_board {"no" if lib.power else "yes"}) (dnp no) (fields_autoplaced yes) (uuid {q(uid(key))}) '
        + ' '.join(props)
        + f' {pin_lines} (instances (project {q(t.id)} (path {q("/" + uid(t.id, "root"))} (reference {q(ref)}) (unit 1)))))'
    )


def build_schematic(t: Template) -> tuple[str, dict[str, LibSymbol]]:
    libs: dict[str, LibSymbol] = {}

    def get(lib_id: str) -> LibSymbol:
        if lib_id not in libs:
            libs[lib_id] = flatten(lib_id)
        return libs[lib_id]

    items: list[str] = []
    pwr = 0
    driven: set[str] = set()  # power nets with a power_out pin on them
    used_power: set[str] = set()
    for part in t.parts:
        lib = get(part.lib_id)
        part.footprint = part.footprint or lib.footprint
        if not part.footprint:
            raise SystemExit(f'{t.id}: {part.ref} ({part.lib_id}) has no footprint')
        known = {p.number for p in lib.pins}
        unknown = set(part.nets) - known
        if unknown:
            raise SystemExit(f'{t.id}: {part.ref} has no pins {sorted(unknown)}')
        sx, sy = part.at[0] * GRID, part.at[1] * GRID
        items.append(symbol_instance(t, lib, part.ref, part.value, part.footprint, sx, sy, 0, f'{t.id}/{part.ref}', False, [p.number for p in lib.pins], part.description))
        # Pins stacked at one spot (hidden GND pins and the like) share one connection.
        done: dict[tuple[float, float], str | None] = {}
        for p in lib.pins:
            px, py = sx + p.x, sy - p.y
            spot = (round(px, 3), round(py, 3))
            net = part.nets.get(p.number)
            if p.type == 'power_out' and net:
                driven.add(net)
            if spot in done:
                if net and done[spot] and net != done[spot]:
                    raise SystemExit(f'{t.id}: {part.ref} pins stacked at {spot} are on {done[spot]} and {net}')
                if net and not done[spot]:
                    raise SystemExit(f'{t.id}: {part.ref} pin {p.number} is stacked on an unconnected pin')
                continue
            done[spot] = net
            key = f'{t.id}/{part.ref}/{p.number}'
            if not net:
                items.append(f'(no_connect (at {fmt(px)} {fmt(py)}) (uuid {q(uid(key, "nc"))}))')
            elif net in POWER_NETS:
                used_power.add(net)
                plib = get(POWER_NETS[net])
                body = POWER_BODY.get(plib.lib_id, 90)
                rot = int((outward(p.angle) - body) % 360)
                pwr += 1
                items.append(symbol_instance(t, plib, f'#PWR{pwr:03d}', net, '', px, py, rot, key + '/pwr', True, ['1']))
            else:
                items.append(label_sexpr(net, px, py, outward(p.angle), key + '/label'))
    # PWR_FLAG on every supply that no regulator output drives, beside the title block.
    flag = get('power:PWR_FLAG')
    for i, net in enumerate(sorted(used_power - driven)):
        x, y = (20 + 8 * i) * GRID, 6 * GRID
        key = f'{t.id}/flag/{net}'
        pwr += 1
        items.append(symbol_instance(t, flag, f'#FLG{i + 1:02d}', 'PWR_FLAG', '', x, y, 0, key, True, ['1']))
        plib = get(POWER_NETS[net])
        items.append(symbol_instance(t, plib, f'#PWR{pwr:03d}', net, '', x, y, 180 if POWER_BODY.get(plib.lib_id, 90) == 90 else 0, key + '/pwr', True, ['1']))

    lib_block = '\n\t\t'.join(dump(l.tree, 2) for l in libs.values())
    sch = f'''(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid {q(uid(t.id, "root"))})
\t(paper "A3")
\t(title_block
\t\t(title {q(t.title)})
\t\t(rev "A")
\t\t(company "Jumper starter template")
\t\t(comment 1 {q(t.comment)})
\t\t(comment 2 "Symbols and footprints from the KiCad libraries. Check every value against your parts before ordering.")
\t)
\t(lib_symbols
\t\t{lib_block}
\t)
\t{(chr(10) + chr(9)).join(items)}
\t(sheet_instances (path "/" (page "1")))
\t(embedded_fonts no)
)
'''
    return sch, libs


# ---------------------------------------------------------------- board

def build_board(t: Template, netlist_path: Path, out: Path) -> None:
    import pcbnew  # noqa: PLC0415 - only needed here, and only importable where KiCad is installed

    tree = parse(netlist_path.read_text())
    comps = children(child(tree, 'components'), 'comp')
    nets = children(child(tree, 'nets'), 'net')
    pad_net: dict[tuple[str, str], str] = {}
    for n in nets:
        name = unq(child(n, 'name')[1])
        for node in children(n, 'node'):
            pad_net[(unq(child(node, 'ref')[1]), unq(child(node, 'pin')[1]))] = name

    board = pcbnew.BOARD()
    ds = board.GetDesignSettings()
    ds.SetCopperLayerCount(2)
    # KiCad's ESP32-S3 module footprint has 0.2 mm thermal vias; most fabs drill that.
    ds.m_MinThroughDrill = pcbnew.FromMM(0.2)
    netinfo: dict[str, object] = {}
    for name in sorted(set(pad_net.values())):
        ni = pcbnew.NETINFO_ITEM(board, name)
        board.Add(ni)
        netinfo[name] = ni

    mm = pcbnew.FromMM
    footprints = []
    for comp in comps:
        ref = unq(child(comp, 'ref')[1])
        value = unq(child(comp, 'value')[1])
        fpid = unq(child(comp, 'footprint')[1])
        lib, name = fpid.split(':')
        fp = pcbnew.FootprintLoad(str(FOOTPRINTS / f'{lib}.pretty'), name)
        if fp is None:
            raise SystemExit(f'{t.id}: footprint {fpid} not found')
        fp.SetFPID(pcbnew.LIB_ID(lib, name))
        fp.SetReference(ref)
        fp.SetValue(value)
        tstamps = child(comp, 'tstamps')
        sheet = child(comp, 'sheetpath')
        fp.SetPath(pcbnew.KIID_PATH(unq(child(sheet, 'tstamps')[1]) + unq(tstamps[1])))
        for pad in fp.Pads():
            net = pad_net.get((ref, pad.GetNumber()))
            if net:
                pad.SetNet(netinfo[net])
        board.Add(fp)
        footprints.append(fp)

    # Shelf-pack the footprints by courtyard, biggest first, inside the outline.
    w, h = t.board
    margin, gap = 3.0, 1.5
    def size(fp):
        bb = fp.GetCourtyard(pcbnew.F_CrtYd).BBox() if fp.GetCourtyard(pcbnew.F_CrtYd).OutlineCount() else fp.GetBoundingBox(False, False)
        return pcbnew.ToMM(bb.GetWidth()), pcbnew.ToMM(bb.GetHeight()), bb
    order = sorted(footprints, key=lambda f: -size(f)[0] * size(f)[1])
    while True:
        x, y, row_h, ok = margin, margin, 0.0, True
        placed = []
        for fp in order:
            fw, fh, _ = size(fp)
            if x + fw > w - margin:
                x, y, row_h = margin, y + row_h + gap, 0.0
            if y + fh > h - margin:
                ok = False
                break
            placed.append((fp, x, y))
            x += fw + gap
            row_h = max(row_h, fh)
        if ok:
            break
        w, h = w + 5, h + 4
    # Put the board on the drawing sheet rather than at its corner.
    ox, oy = 100.0, 60.0
    for fp, x, y in placed:
        _, _, bb = size(fp)
        pos = fp.GetPosition()
        fp.SetPosition(pcbnew.VECTOR2I(pos.x + mm(ox + x) - bb.GetX(), pos.y + mm(oy + y) - bb.GetY()))

    corners = [(ox, oy), (ox + w, oy), (ox + w, oy + h), (ox, oy + h)]
    for (x1, y1), (x2, y2) in zip(corners, corners[1:] + corners[:1]):
        seg = pcbnew.PCB_SHAPE(board)
        seg.SetShape(pcbnew.SHAPE_T_SEGMENT)
        seg.SetLayer(pcbnew.Edge_Cuts)
        seg.SetWidth(mm(0.1))
        seg.SetStart(pcbnew.VECTOR2I(mm(x1), mm(y1)))
        seg.SetEnd(pcbnew.VECTOR2I(mm(x2), mm(y2)))
        board.Add(seg)
    tb = board.GetTitleBlock()
    tb.SetTitle(t.title)
    tb.SetRevision('A')
    tb.SetCompany('Jumper starter template')
    pcbnew.SaveBoard(str(out), board)


PROJECT = {
    'meta': {'version': 3},
    'board': {'design_settings': {'rules': {'min_clearance': 0.2, 'min_track_width': 0.2, 'min_through_hole_diameter': 0.2, 'min_via_diameter': 0.4}, 'rule_severities': {'lib_footprint_mismatch': 'ignore', 'lib_footprint_issues': 'ignore'}}},
    'erc': {'rule_severities': {'lib_symbol_mismatch': 'ignore', 'lib_symbol_issues': 'ignore', 'footprint_link_issues': 'ignore'}},
}

JUMPER_YML = '''# Checks for this board. Reference: /docs/jumper-yml
checks:
  erc:
    fail_on: error
  drc:
    fail_on: error
    schematic_parity: true
    # The board starts unrouted. Switch this on once every connection is routed.
    fail_on_unconnected: false
'''


def readme(t: Template, includes: str) -> str:
    return f'''# {t.title}

{t.comment}

Started from the Jumper **{t.title}** template. Symbols and footprints come from the KiCad 9 libraries.

## What is here

- `{t.id}.kicad_sch`: schematic. Pins are tied together with net labels and power symbols.
- `{t.id}.kicad_pcb`: board with the outline and every footprint placed and netted, not routed yet.
- `.jumper.yml`: checks. Unrouted connections are not counted as errors until you switch `fail_on_unconnected` on.

## Next steps

1. Check every value and footprint against the parts you will buy.
2. Arrange the parts on the board and route it.
3. Set `fail_on_unconnected: true` in `.jumper.yml` so unrouted connections fail the check.
'''


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def check(t: Template, d: Path) -> None:
    sch, pcb = d / f'{t.id}.kicad_sch', d / f'{t.id}.kicad_pcb'
    erc = d / 'erc.json'
    run(['kicad-cli', 'sch', 'erc', '--format', 'json', '--severity-all', '-o', str(erc), str(sch)])
    problems = [v for s in json.loads(erc.read_text())['sheets'] for v in s['violations']]
    if problems:
        for v in problems:
            print(f'  ERC {v["severity"]} {v["type"]}: {v["description"]} {[i["description"] for i in v["items"]]}', file=sys.stderr)
        raise SystemExit(f'{t.id}: ERC found {len(problems)} problems')
    drc = d / 'drc.json'
    run(['kicad-cli', 'pcb', 'drc', '--format', 'json', '--schematic-parity', '--severity-error', '--severity-warning', '-o', str(drc), str(pcb)])
    rep = json.loads(drc.read_text())
    bad = rep.get('violations', []) + rep.get('schematic_parity', [])
    if bad:
        for v in bad:
            print(f'  DRC {v["severity"]} {v["type"]}: {v["description"]} {[i["description"] for i in v["items"]]}', file=sys.stderr)
        raise SystemExit(f'{t.id}: DRC found {len(bad)} problems')
    print(f'{t.id}: ERC clean, DRC clean, {len(rep.get("unconnected_items", []))} connections to route')


def main() -> None:
    files: dict[str, dict[str, str]] = {}
    for t in (esp32(), stm32(), rp2040()):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            sch, _ = build_schematic(t)
            (d / f'{t.id}.kicad_sch').write_text(sch)
            pro = json.loads(json.dumps(PROJECT))
            pro['meta']['filename'] = f'{t.id}.kicad_pro'
            (d / f'{t.id}.kicad_pro').write_text(json.dumps(pro, indent=2) + '\n')
            run(['kicad-cli', 'sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', str(d / 'net.net'), str(d / f'{t.id}.kicad_sch')])
            build_board(t, d / 'net.net', d / f'{t.id}.kicad_pcb')
            check(t, d)
            files[t.id] = {
                f'{t.id}.kicad_pro': (d / f'{t.id}.kicad_pro').read_text(),
                f'{t.id}.kicad_sch': (d / f'{t.id}.kicad_sch').read_text(),
                f'{t.id}.kicad_pcb': (d / f'{t.id}.kicad_pcb').read_text(),
                '.jumper.yml': JUMPER_YML,
                'README.md': readme(t, ''),
            }
    body = json.dumps(files, indent=2, ensure_ascii=False)
    OUT.write_text(
        '// Generated by scripts/templates/build.py from the KiCad 9 symbol and footprint libraries. Do not edit by hand.\n'
        f'export const TEMPLATE_FILES: Record<string, Record<string, string>> = {body};\n'
    )
    print(f'wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
