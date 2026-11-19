#!/usr/bin/env python3
"""
Build the homepage "drag the change" assets: two revisions of the same real board.

Rev A is the RoyalBlue54L Feather exactly as KiCad ships it (CERN-OHL-P-2.0, Lord's Boards).
Rev B is an EXAMPLE change made by this script, labelled as such on the page:
  1. J4 (the JST battery connector) removed, with the track stubs on its pads.
  2. SW3, a second push button, added where J4 was.
  3. D1 (status LED) moved 1.6 mm left; its tracks are stretched to follow the pads.
  4. R6 value 470R -> 1k (dimmer status LED).
  5. Two test pads added on the SWD lines (TP12 SWDIO, TP13 SWDCLK).

Both revisions are rendered with the same kicad-cli camera so the images align pixel for pixel.

Outputs (apps/web/src/features/home/diff/assets/):
  rev-a.webp, rev-b.webp   raytraced top views, same crop
  changes.json             size, and each change with its box (0..1) for the highlight rings

Requires KiCad 9 (kicad-cli + pcbnew Python module) and Pillow.
Usage: python3 scripts/hero-board/diff.py
"""
import json
import os
import shutil
import subprocess
import tempfile

import pcbnew
from PIL import Image

DEMO = '/usr/share/kicad/demos/royalblue54L_feather'
NAME = 'RoyalBlue54L-Feather'
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'apps', 'web', 'src', 'features', 'home', 'diff', 'assets')
MASK = '#123D27E8'  # same deep green as the x-ray hero
RENDER = dict(w=3200, h=1500, zoom=1.7)
MARGIN = 56
FINAL_W = 2000
FP_LIB = '/usr/share/kicad/footprints/TestPoint.pretty'
MM = pcbnew.FromMM


def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def render(pcb, png):
    run('kicad-cli', 'pcb', 'render', '--side', 'top', '--background', 'transparent', '--quality', 'high',
        '--zoom', str(RENDER['zoom']), '-w', str(RENDER['w']), '-h', str(RENDER['h']), '-o', png, pcb)


def opaque_bbox(im):
    return im.getchannel('A').point(lambda v: 255 if v > 250 else 0).getbbox()


def bbox_mm(item):
    b = item.GetBoundingBox()
    return [pcbnew.ToMM(b.GetX()), pcbnew.ToMM(b.GetY()), pcbnew.ToMM(b.GetRight()), pcbnew.ToMM(b.GetBottom())]


def pads_mm(fp):
    return union([bbox_mm(p) for p in fp.Pads()])


def union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    k = 0 if L == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
    return ((px - ax - k * dx) ** 2 + (py - ay - k * dy) ** 2) ** 0.5


def free_spot(board, near, radius=1.0, avoid=()):
    """Nearest point to `near` (mm) with no top-side pad, part body or track within `radius`."""
    edge = board.GetBoardEdgesBoundingBox()
    x0, y0 = pcbnew.ToMM(edge.GetX()) + 3, pcbnew.ToMM(edge.GetY()) + 3
    x1, y1 = pcbnew.ToMM(edge.GetRight()) - 3, pcbnew.ToMM(edge.GetBottom()) - 3
    boxes = list(avoid)
    for f in board.GetFootprints():
        if f.GetLayer() == pcbnew.F_Cu:
            boxes += [bbox_mm(p) for p in f.Pads()]
            c = f.GetCourtyard(pcbnew.F_CrtYd)
            if c.OutlineCount():
                bb = c.BBox()
                boxes.append([pcbnew.ToMM(bb.GetX()), pcbnew.ToMM(bb.GetY()), pcbnew.ToMM(bb.GetRight()), pcbnew.ToMM(bb.GetBottom())])
    for d in board.GetDrawings():
        if d.GetLayer() == pcbnew.F_SilkS:
            boxes.append(bbox_mm(d))
    for f in board.GetFootprints():
        for g in f.GraphicalItems():
            if g.GetLayer() == pcbnew.F_SilkS:
                boxes.append(bbox_mm(g))
        for txt in (f.Reference(), f.Value()):
            if txt.IsVisible() and txt.GetLayer() == pcbnew.F_SilkS:
                boxes.append(bbox_mm(txt))
    segs = []
    for t in board.GetTracks():
        if t.GetClass() == 'PCB_VIA':
            q = t.GetPosition()
            segs.append((pcbnew.ToMM(q.x), pcbnew.ToMM(q.y), pcbnew.ToMM(q.x), pcbnew.ToMM(q.y), pcbnew.ToMM(t.GetWidth(pcbnew.F_Cu)) / 2))
        elif t.GetLayer() == pcbnew.F_Cu:
            a, b = t.GetStart(), t.GetEnd()
            segs.append((pcbnew.ToMM(a.x), pcbnew.ToMM(a.y), pcbnew.ToMM(b.x), pcbnew.ToMM(b.y), pcbnew.ToMM(t.GetWidth()) / 2))
    best = None
    y = y0
    while y <= y1:
        x = x0
        while x <= x1:
            ok = all(x + radius < b[0] or x - radius > b[2] or y + radius < b[1] or y - radius > b[3] for b in boxes)
            if ok and all(seg_dist(x, y, *sg[:4]) > radius + sg[4] for sg in segs):
                d = (x - near[0]) ** 2 + (y - near[1]) ** 2
                if best is None or d < best[0]:
                    best = (d, x, y)
            x += 0.25
        y += 0.25
    if best is None:
        raise SystemExit('no free spot for a test pad')
    return best[1], best[2]


def make_rev_b(src, dst):
    board = pcbnew.LoadBoard(src)
    changes = []

    # 1-2. Remove the battery connector and put a second push button in the space it frees.
    j4 = board.FindFootprintByReference('J4')
    j4_box = pads_mm(j4)
    centre = j4.GetPosition()
    pads = {(p.GetPosition().x, p.GetPosition().y) for p in j4.Pads()}
    for t in list(board.GetTracks()):
        if t.GetClass() == 'PCB_TRACK' and ((t.GetStart().x, t.GetStart().y) in pads or (t.GetEnd().x, t.GetEnd().y) in pads):
            board.Remove(t)
    board.Remove(j4)
    changes.append({'id': 'j4', 'kind': 'removed', 'ref': 'J4', 'title': 'J4 removed', 'detail': 'JST battery connector, and the track stubs on its pads', 'mm': j4_box})
    sw3 = board.FindFootprintByReference('SW1').Duplicate()
    sw3.SetReference('SW3')
    sw3.SetPosition(centre)
    sw3.SetOrientationDegrees(90)
    for p in sw3.Pads():
        p.SetNetCode(0)
    board.Add(sw3)
    changes.append({'id': 'sw3', 'kind': 'added', 'ref': 'SW3', 'title': 'SW3 added', 'detail': 'A second push button where the connector was', 'mm': pads_mm(sw3)})

    # 3. Move D1 left, stretching every track end that sat on one of its pads.
    d1 = board.FindFootprintByReference('D1')
    before = pads_mm(d1)
    old = {p.GetNumber(): p.GetPosition() for p in d1.Pads()}
    d1.Move(pcbnew.VECTOR2I(MM(-1.6), 0))
    new = {p.GetNumber(): p.GetPosition() for p in d1.Pads()}
    for t in board.GetTracks():
        if t.GetClass() != 'PCB_TRACK':
            continue
        for num, pos in old.items():
            if t.GetStart() == pos:
                t.SetStart(new[num])
            if t.GetEnd() == pos:
                t.SetEnd(new[num])
    changes.append({'id': 'd1', 'kind': 'moved', 'ref': 'D1', 'title': 'D1 moved 1.6 mm left', 'detail': 'Status LED, tracks follow the pads', 'mm': union([before, pads_mm(d1)])})

    # 4. Value change.
    r6 = board.FindFootprintByReference('R6')
    r6.SetValue('1k')
    changes.append({'id': 'r6', 'kind': 'changed', 'ref': 'R6', 'title': 'R6 470R → 1k', 'detail': 'Value only: the render is identical, the diff still catches it', 'mm': pads_mm(r6)})

    # 5. Two test pads on the SWD lines, near the debugger.
    io = pcbnew.FootprintLoad(FP_LIB, 'TestPoint_Pad_D1.5mm')
    # Keep the new pads clear of the J4/SW3 area so their highlights do not stack.
    placed = [[j4_box[0] - 0.2, j4_box[1] - 0.2, j4_box[2] + 0.2, j4_box[3] + 0.2]]
    for ref, net, near in (('TP12', '/Debugger/SWD_TRG.SWDIO', (146.0, 101.0)), ('TP13', '/Debugger/SWD_TRG.SWDCLK', (146.0, 101.0))):
        x, y = free_spot(board, near, avoid=placed)
        fp = pcbnew.FootprintLoad(FP_LIB, 'TestPoint_Pad_D1.5mm') if len(placed) > 1 else io
        fp.SetReference(ref)
        fp.SetValue('TestPoint')
        fp.Reference().SetVisible(False)
        fp.SetPosition(pcbnew.VECTOR2I(MM(x), MM(y)))
        board.Add(fp)
        n = board.FindNet(net)
        for p in fp.Pads():
            p.SetNet(n)
        box = pads_mm(fp)
        placed.append([box[0] - 1.5, box[1] - 1.5, box[2] + 1.5, box[3] + 1.5])
        changes.append({'id': ref.lower(), 'kind': 'added', 'ref': ref, 'title': f'{ref} added', 'detail': f'Test pad on {net.split(".")[-1]}', 'mm': box})

    pcbnew.SaveBoard(dst, board)
    return changes


def main():
    tmp = tempfile.mkdtemp(prefix='hero-diff-')
    shutil.copytree(DEMO, tmp, dirs_exist_ok=True)
    a = os.path.join(tmp, NAME + '.kicad_pcb')
    text = open(a).read().replace('(color "Blue")', f'(color "{MASK}")')
    open(a, 'w').write(text)
    # The bare board (no 3D models) gives the outline's pixel box; build it before any edits.
    bare_board = pcbnew.LoadBoard(a)
    edge = bare_board.GetBoardEdgesBoundingBox()
    for fp in bare_board.GetFootprints():
        fp.Models().clear()
    bare = os.path.join(tmp, 'bare.kicad_pcb')
    pcbnew.SaveBoard(bare, bare_board)

    b = os.path.join(tmp, 'rev-b.kicad_pcb')
    changes = make_rev_b(a, b)

    pa, pb, pbare = (os.path.join(tmp, n) for n in ('a.png', 'b.png', 'bare.png'))
    for pcb, png in ((a, pa), (b, pb), (bare, pbare)):
        render(pcb, png)

    bx0, by0, bx1, by1 = opaque_bbox(Image.open(pbare))
    ex, ey = pcbnew.ToMM(edge.GetX()), pcbnew.ToMM(edge.GetY())
    sx = (bx1 - bx0) / pcbnew.ToMM(edge.GetWidth())
    sy = (by1 - by0) / pcbnew.ToMM(edge.GetHeight())
    crop = (bx0 - MARGIN, by0 - MARGIN, bx1 + MARGIN, by1 + MARGIN)
    cw, ch = crop[2] - crop[0], crop[3] - crop[1]

    os.makedirs(OUT, exist_ok=True)
    scale = FINAL_W / cw
    size = (FINAL_W, round(ch * scale))
    for png, name in ((pa, 'rev-a.webp'), (pb, 'rev-b.webp')):
        im = Image.open(png).convert('RGBA').crop(crop)
        im.putalpha(im.getchannel('A').point(lambda v: 255 if v > 245 else 0))
        im.resize(size, Image.LANCZOS).save(os.path.join(OUT, name), quality=86, method=6)

    pad = 0.6  # mm of breathing room around each highlight
    for c in changes:
        x0, y0, x1, y1 = c.pop('mm')
        px = lambda x: (MARGIN + (x - ex) * sx) / cw  # noqa: E731
        py = lambda y: (MARGIN + (y - ey) * sy) / ch  # noqa: E731
        c['box'] = [round(px(x0 - pad), 4), round(py(y0 - pad), 4), round(px(x1 + pad), 4), round(py(y1 + pad), 4)]

    meta = {
        'width': size[0],
        'height': size[1],
        'board': {'name': 'RoyalBlue54L Feather', 'author': "Lord's Boards", 'license': 'CERN-OHL-P-2.0', 'url': 'https://www.crowdsupply.com/lords-boards/royalblue54l-feather'},
        'changes': sorted(changes, key=lambda c: c['box'][0]),
    }
    json.dump(meta, open(os.path.join(OUT, 'changes.json'), 'w'), indent=1, ensure_ascii=False)
    print(json.dumps(meta['changes'], indent=1, ensure_ascii=False))


if __name__ == '__main__':
    main()
