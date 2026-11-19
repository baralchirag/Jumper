#!/usr/bin/env python3
"""
Build the homepage x-ray hero assets from a real open-source KiCad board.

Board: RoyalBlue54L Feather by Lord's Boards, CERN-OHL-P-2.0, shipped with KiCad as a demo
(/usr/share/kicad/demos/royalblue54L_feather). The only change is the solder-mask colour
(royal blue -> deep green) in a scratch copy.

Outputs (apps/web/src/features/home/xray/assets/):
  board-top.webp     kicad-cli raytraced top view (real 3D models), shadows removed
  board-inside.webp  the board's real copper drawn from pcbnew geometry: F.Cu, In2 (amber),
                     In4 (green) offset for depth, vias, ground planes as hatch
  board.json         size, net labels and real track paths (normalised 0..1) for the signal dots

Requires KiCad 9 (kicad-cli + pcbnew Python module) and Pillow.
Usage: python3 scripts/hero-board/build.py
"""
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

import pcbnew
from PIL import Image, ImageChops, ImageDraw

DEMO = '/usr/share/kicad/demos/royalblue54L_feather'
NAME = 'RoyalBlue54L-Feather'
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'apps', 'web', 'src', 'features', 'home', 'xray', 'assets')
MASK = '#123D27E8'
RENDER = dict(w=3200, h=1500, zoom=1.7)
MARGIN = 72  # px around the board outline in the render (keeps the USB-C overhang)
FINAL_W = 1800
SS = 2  # supersampling for the inside drawing
PLANE_MM2 = 25  # zones larger than this are planes, shown as hatch

COPPER = (224, 138, 79)
AMBER = (224, 178, 60)
GREEN = (76, 184, 108)
GRAPHITE = (18, 17, 16)

# Nets that get a label and a travelling signal dot, with the short name shown.
NETS = {
    '/Debugger/D+': 'D+',
    '/Debugger/D-': 'D−',
    '/Debugger/USB.VBUS': 'VBUS',
    '/Connectors/I2C.SCL': 'SCL',
    '/Connectors/I2C.SDA': 'SDA',
    'VSYS': 'VSYS',
    '/Connectors/UART.TX': 'TX',
    '/nPM1300/NPM1300.SDA': 'PMIC SDA',
}


def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def render(pcb, png):
    run('kicad-cli', 'pcb', 'render', '--side', 'top', '--background', 'transparent', '--quality', 'high',
        '--zoom', str(RENDER['zoom']), '-w', str(RENDER['w']), '-h', str(RENDER['h']), '-o', png, pcb)


def opaque_bbox(im):
    return im.getchannel('A').point(lambda v: 255 if v > 250 else 0).getbbox()


def main():
    tmp = tempfile.mkdtemp(prefix='hero-board-')
    shutil.copytree(DEMO, tmp, dirs_exist_ok=True)
    src = os.path.join(tmp, NAME + '.kicad_pcb')
    text = open(src).read().replace('(color "Blue")', f'(color "{MASK}")')
    open(src, 'w').write(text)

    board = pcbnew.LoadBoard(src)
    bare_board = pcbnew.LoadBoard(src)
    for fp in bare_board.GetFootprints():
        fp.Models().clear()
    bare = os.path.join(tmp, 'bare.kicad_pcb')
    pcbnew.SaveBoard(bare, bare_board)

    full_png, bare_png = os.path.join(tmp, 'full.png'), os.path.join(tmp, 'bare.png')
    print('rendering top view…', file=sys.stderr)
    render(src, full_png)
    render(bare, bare_png)

    # Board outline in render pixels, from the bare board (no parts overhanging).
    bx0, by0, bx1, by1 = opaque_bbox(Image.open(bare_png))
    edge = board.GetBoardEdgesBoundingBox()
    ex, ey = pcbnew.ToMM(edge.GetX()), pcbnew.ToMM(edge.GetY())
    ew, eh = pcbnew.ToMM(edge.GetWidth()), pcbnew.ToMM(edge.GetHeight())
    sx, sy = (bx1 - bx0) / ew, (by1 - by0) / eh
    crop = (bx0 - MARGIN, by0 - MARGIN, bx1 + MARGIN, by1 + MARGIN)
    cw, ch = crop[2] - crop[0], crop[3] - crop[1]

    # Top: keep only fully opaque pixels (drops the soft ground shadow on transparent background).
    top = Image.open(full_png).convert('RGBA').crop(crop)
    a = top.getchannel('A').point(lambda v: 255 if v > 245 else 0)
    top.putalpha(a)

    # mm -> inside canvas px (supersampled).
    def P(x, y):
        return ((pcbnew.ToMM(x) - ex) * sx * SS + MARGIN * SS, (pcbnew.ToMM(y) - ey) * sy * SS + MARGIN * SS)

    def norm(x, y):
        px, py = P(x, y)
        return [round(px / (cw * SS), 5), round(py / (ch * SS), 5)]

    W, H = cw * SS, ch * SS
    lid = board.GetLayerID

    def poly_points(chain, dx=0, dy=0):
        return [(P(chain.CPoint(i).x, chain.CPoint(i).y)[0] + dx, P(chain.CPoint(i).x, chain.CPoint(i).y)[1] + dy) for i in range(chain.PointCount())]

    outline = pcbnew.SHAPE_POLY_SET()
    board.GetBoardPolygonOutlines(outline)
    board_mask = Image.new('L', (W, H), 0)
    md = ImageDraw.Draw(board_mask)
    for i in range(outline.OutlineCount()):
        md.polygon(poly_points(outline.Outline(i)), fill=255)
        for h in range(outline.HoleCount(i)):
            md.polygon(poly_points(outline.Hole(i, h)), fill=0)

    def track_pts(t):
        if t.GetClass() == 'PCB_ARC':
            c = t.GetCenter()
            r = math.hypot(t.GetStart().x - c.x, t.GetStart().y - c.y)
            a0 = math.atan2(t.GetStart().y - c.y, t.GetStart().x - c.x)
            am = math.atan2(t.GetMid().y - c.y, t.GetMid().x - c.x)
            a1 = math.atan2(t.GetEnd().y - c.y, t.GetEnd().x - c.x)
            # choose the sweep direction that passes through the midpoint
            def sweep(f, to):
                d = (to - f) % (2 * math.pi)
                return d
            ccw = sweep(a0, am) < sweep(a0, a1)
            total = sweep(a0, a1) if ccw else -sweep(a1, a0)
            n = 12
            return [(c.x + r * math.cos(a0 + total * k / n), c.y + r * math.sin(a0 + total * k / n)) for k in range(n + 1)]
        return [(t.GetStart().x, t.GetStart().y), (t.GetEnd().x, t.GetEnd().y)]

    def draw_layer(img, layer, color, alpha, dx=0, dy=0, zones=True, skip_gnd_zone=True):
        d = ImageDraw.Draw(img, 'RGBA')
        fill = color + (alpha,)
        if zones:
            for z in board.Zones():
                if not z.IsOnLayer(layer) or z.GetIsRuleArea():
                    continue
                if skip_gnd_zone and z.GetNetname() == 'GND':
                    continue
                # Power/ground planes would flood the view; only small copper areas are drawn solid.
                if pcbnew.ToMM(pcbnew.ToMM(z.GetFilledArea())) > PLANE_MM2:
                    continue
                polys = z.GetFilledPolysList(layer)
                for i in range(polys.OutlineCount()):
                    d.polygon(poly_points(polys.Outline(i), dx, dy), fill=fill)
        for t in board.GetTracks():
            if t.GetClass() == 'PCB_VIA' or t.GetLayer() != layer:
                continue
            w = pcbnew.ToMM(t.GetWidth()) * sx * SS
            pts = [P(x, y) for x, y in track_pts(t)]
            pts = [(x + dx, y + dy) for x, y in pts]
            d.line(pts, fill=fill, width=max(1, round(w)), joint='curve')
            for x, y in (pts[0], pts[-1]):
                d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=fill)

    print('drawing copper…', file=sys.stderr)
    base = Image.new('RGBA', (W, H), GRAPHITE + (255,))
    # Ground planes (In1/In3/In6 + F.Cu GND pour) as a faint 45° hatch.
    hatch = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hatch)
    step = 9 * SS * 2
    for k in range(-H, W, step):
        hd.line([(k, H), (k + H, 0)], fill=COPPER + (26,), width=SS)
    base.alpha_composite(hatch)

    off = round(0.22 * sx * SS)  # inner-layer offset, ~0.22 mm
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    draw_layer(layer, lid('In4.Cu'), GREEN, 120, off * 2, off * 2)
    draw_layer(layer, lid('In2.Cu'), AMBER, 175, off, off)
    base.alpha_composite(layer)

    # F.Cu GND pour: a denser hatch, so the pour reads without hiding the traces.
    pour = Image.new('L', (W, H), 0)
    pd = ImageDraw.Draw(pour)
    for z in board.Zones():
        if z.GetNetname() == 'GND' and z.IsOnLayer(lid('F.Cu')):
            polys = z.GetFilledPolysList(lid('F.Cu'))
            for i in range(polys.OutlineCount()):
                pd.polygon(poly_points(polys.Outline(i)), fill=255)
    dense = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dense)
    for k in range(-H, W, 5 * SS * 2):
        dd.line([(k, H), (k + H, 0)], fill=COPPER + (60,), width=SS)
    dense.putalpha(ImageChops.multiply(dense.getchannel('A'), pour))
    base.alpha_composite(dense)

    top_cu = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    draw_layer(top_cu, lid('F.Cu'), COPPER, 255)
    td = ImageDraw.Draw(top_cu, 'RGBA')
    holes = []
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            if not pad.IsOnLayer(lid('F.Cu')):
                continue
            ps = pcbnew.SHAPE_POLY_SET()
            pad.TransformShapeToPolygon(ps, lid('F.Cu'), 0, pcbnew.FromMM(0.005), pcbnew.ERROR_INSIDE)
            for i in range(ps.OutlineCount()):
                td.polygon(poly_points(ps.Outline(i)), fill=COPPER + (255,))
            if pad.HasHole():
                dsz = pad.GetDrillSize()
                holes.append((pad.GetPosition(), pcbnew.ToMM(min(dsz.x, dsz.y)) / 2))
    for v in board.GetTracks():
        if v.GetClass() != 'PCB_VIA':
            continue
        x, y = P(v.GetPosition().x, v.GetPosition().y)
        r = pcbnew.ToMM(v.GetWidth(lid('F.Cu'))) / 2 * sx * SS
        td.ellipse((x - r, y - r, x + r, y + r), fill=COPPER + (255,))
        holes.append((v.GetPosition(), pcbnew.ToMM(v.GetDrillValue()) / 2))
    base.alpha_composite(top_cu)
    bd = ImageDraw.Draw(base)
    for pos, r_mm in holes:
        x, y = P(pos.x, pos.y)
        r = r_mm * sx * SS
        bd.ellipse((x - r, y - r, x + r, y + r), fill=GRAPHITE + (255,))

    # Board edge line and clip to outline.
    inside = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    inside.paste(base, (0, 0), board_mask)
    ed = ImageDraw.Draw(inside, 'RGBA')
    for i in range(outline.OutlineCount()):
        pts = poly_points(outline.Outline(i))
        ed.line(pts + pts[:1], fill=COPPER + (110,), width=2 * SS)

    # Nets: longest F.Cu chain per net -> label position + dot path.
    nets = []
    for netname, short in NETS.items():
        segs = []
        for t in board.GetTracks():
            if t.GetClass() == 'PCB_VIA' or t.GetLayer() != lid('F.Cu') or t.GetNetname() != netname:
                continue
            segs.append(track_pts(t))
        if not segs:
            continue
        chains = chain_segments(segs)
        best = max(chains, key=length)
        if length(best) < pcbnew.FromMM(4):
            continue
        # label on the longest straight-ish run
        i = max(range(len(best) - 1), key=lambda k: math.hypot(best[k + 1][0] - best[k][0], best[k + 1][1] - best[k][1]))
        (x0, y0), (x1, y1) = best[i], best[i + 1]
        nets.append({
            'net': netname,
            'label': short,
            'at': norm((x0 + x1) / 2, (y0 + y1) / 2),
            'angle': round(math.degrees(math.atan2(y1 - y0, x1 - x0)), 1),
            'path': [norm(x, y) for x, y in best],
        })

    os.makedirs(OUT, exist_ok=True)
    fw = FINAL_W
    fh = round(ch * fw / cw)
    top.resize((fw, fh), Image.LANCZOS).save(os.path.join(OUT, 'board-top.webp'), quality=88, method=6)
    inside.resize((fw, fh), Image.LANCZOS).save(os.path.join(OUT, 'board-inside.webp'), quality=90, method=6)
    meta = {
        'width': fw,
        'height': fh,
        'board': {'name': 'RoyalBlue54L Feather', 'author': "Lord's Boards", 'license': 'CERN-OHL-P-2.0',
                  'url': 'https://www.crowdsupply.com/lords-boards/royalblue54l-feather', 'sizeMm': [round(ew, 2), round(eh, 2)],
                  'copperLayers': board.GetCopperLayerCount()},
        'nets': nets,
    }
    json.dump(meta, open(os.path.join(OUT, 'board.json'), 'w'), indent=1)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f'wrote {OUT} ({fw}x{fh}, {len(nets)} nets)', file=sys.stderr)


def chain_segments(segs):
    """Join track segments that share endpoints into polylines."""
    key = lambda p: (round(p[0] / 1000), round(p[1] / 1000))  # 1 µm grid
    remaining = [list(s) for s in segs]
    chains = []
    while remaining:
        chain = remaining.pop()
        grew = True
        while grew:
            grew = False
            for s in remaining:
                if key(s[0]) == key(chain[-1]):
                    chain += s[1:]
                elif key(s[-1]) == key(chain[-1]):
                    chain += s[-2::-1]
                elif key(s[-1]) == key(chain[0]):
                    chain = s[:-1] + chain
                elif key(s[0]) == key(chain[0]):
                    chain = s[:0:-1] + chain
                else:
                    continue
                remaining.remove(s)
                grew = True
                break
        chains.append(chain)
    return chains


def length(chain):
    return sum(math.hypot(chain[i + 1][0] - chain[i][0], chain[i + 1][1] - chain[i][1]) for i in range(len(chain) - 1))


if __name__ == '__main__':
    main()
