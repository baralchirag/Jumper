#!/usr/bin/env python3
"""
Build local demo repositories from the projects KiCad ships in /usr/share/kicad/demos, each with a short history of
real edits made through KiCad's own Python API, so diffs, comments and compare can be tried on a dev instance.

For every project:
  main   1. Import       the project as KiCad ships it (boards re-saved through pcbnew so strict parsers read them)
         2. Values       two or three resistor/capacitor values changed, on the board and in the schematic
         3. Placement    two parts moved; their tracks are stretched to follow the pads
  next   4. Parts        one part removed with its track stubs, a test pad added on a signal net
         5. Routing      every track on the main power net widened by 0.1 mm
ecc83 also gets the second board revision KiCad ships (ecc83-pp_v2) as a commit on main.

Usage: python3 scripts/demo-repos/build.py OUT_DIR
Each OUT_DIR/<name> is a git repository with branches main and next, ready to push.
Requires KiCad 9 (pcbnew Python module). The demo projects keep their own licences.
"""
import os
import random
import re
import shutil
import subprocess
import sys

import pcbnew

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'hero-board'))
from diff import FP_LIB, free_spot  # noqa: E402

DEMOS = '/usr/share/kicad/demos'
PROJECTS = [
    ('stickhub', 'stickhub', 'StickHub', 'USB 2.0 hub on a stick'),
    ('pic-programmer', 'pic_programmer', 'pic_programmer', 'PIC microcontroller programmer'),
    ('ecc83-preamp', 'ecc83', 'ecc83-pp', 'ECC83 valve push-pull preamplifier'),
    ('interf-u', 'interf_u', 'interf_u', 'Interface board'),
    ('coldfire-devkit', 'kit-dev-coldfire-xilinx_5213', 'kit-dev-coldfire-xilinx_5213', 'ColdFire 5213 and Xilinx CPLD development kit'),
]
MM = pcbnew.FromMM
VALUES = {
    'R': ['1k', '2.2k', '4.7k', '10k', '22k', '47k', '100k', '220R', '470R'],
    'C': ['100nF', '1uF', '4.7uF', '10uF', '22pF', '1nF', '47nF'],
}


def git(cwd, *args):
    subprocess.run(['git', *args], cwd=cwd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def commit(cwd, message, date):
    git(cwd, 'add', '-A')
    env = {**os.environ, 'GIT_AUTHOR_DATE': date, 'GIT_COMMITTER_DATE': date}
    subprocess.run(['git', 'commit', '-q', '-m', message], cwd=cwd, check=True, env=env, stdout=subprocess.DEVNULL)


def boards(cwd):
    return [os.path.join(cwd, f) for f in sorted(os.listdir(cwd)) if f.endswith('.kicad_pcb')]


def main_board(cwd, stem):
    return os.path.join(cwd, stem + '.kicad_pcb')


def refs(board, prefix):
    out = []
    for f in board.GetFootprints():
        r = f.GetReference()
        if re.fullmatch(prefix + r'\d+', r) and f.Pads().__len__() == 2:
            out.append(f)
    return sorted(out, key=lambda f: int(re.sub(r'\D', '', f.GetReference()) or 0))


def set_sch_value(cwd, ref, value):
    """Change a symbol's Value in whichever schematic sheet holds it (keeps the board and schematic in step)."""
    for name in os.listdir(cwd):
        if not name.endswith('.kicad_sch'):
            continue
        path = os.path.join(cwd, name)
        text = open(path, encoding='utf-8').read()
        # A placed symbol block: (symbol (lib_id ...) ... (property "Reference" "R5" ...) ... (property "Value" "10k" ...
        pattern = re.compile(r'(\(symbol\s+\(lib_id[^\n]*\n(?:(?!\n\t\(symbol\s+\(lib_id).)*?\(property "Reference" "' + re.escape(ref) + r'".*?\(property "Value" ")([^"]*)(")', re.S)
        new, n = pattern.subn(lambda m: m.group(1) + value + m.group(3), text, count=1)
        if not n:
            pattern = re.compile(r'(\(property "Reference" "' + re.escape(ref) + r'"(?:(?!\(symbol\s+\(lib_id).)*?\(property "Value" ")([^"]*)(")', re.S)
            new, n = pattern.subn(lambda m: m.group(1) + value + m.group(3), text, count=1)
        if n:
            open(path, 'w', encoding='utf-8').write(new)
            return True
    return False


def stretch_tracks(board, fp, dx, dy):
    """Move the track ends that sat on `fp`'s pads by the same offset as the part."""
    pads = {(p.GetPosition().x, p.GetPosition().y) for p in fp.Pads()}
    for t in board.GetTracks():
        if t.GetClass() != 'PCB_TRACK':
            continue
        s, e = t.GetStart(), t.GetEnd()
        if (s.x, s.y) in pads:
            t.SetStart(pcbnew.VECTOR2I(s.x + dx, s.y + dy))
        if (e.x, e.y) in pads:
            t.SetEnd(pcbnew.VECTOR2I(e.x + dx, e.y + dy))


def step_values(cwd, stem, rnd):
    board = pcbnew.LoadBoard(main_board(cwd, stem))
    picked = []
    for prefix in ('R', 'C'):
        cands = [f for f in refs(board, prefix) if f.GetValue() in VALUES[prefix] or re.match(r'^\d', f.GetValue())]
        rnd.shuffle(cands)
        for f in cands[: 2 if prefix == 'R' else 1]:
            norm = lambda v: v.lower().replace(',', '.').rstrip('rΩ').replace('uf', 'u').replace('nf', 'n').replace('pf', 'p')
            choices = [v for v in VALUES[prefix] if norm(v) != norm(f.GetValue())]
            new = rnd.choice(choices)
            picked.append((f.GetReference(), f.GetValue(), new))
            f.SetValue(new)
            set_sch_value(cwd, f.GetReference(), new)
    pcbnew.SaveBoard(main_board(cwd, stem), board)
    return 'Tune values: ' + ', '.join(f'{r} {a} -> {b}' for r, a, b in picked)


def step_move(cwd, stem, rnd):
    board = pcbnew.LoadBoard(main_board(cwd, stem))
    parts = [f for f in board.GetFootprints() if re.match(r'^(R|C|D|LED)\d+$', f.GetReference()) and len(f.Pads()) == 2 and not f.IsLocked()]
    rnd.shuffle(parts)
    moved = []
    for f in parts[:2]:
        dx, dy = MM(rnd.choice([-1.27, 1.27, -0.635, 0.635])), MM(rnd.choice([-1.27, 0, 1.27]))
        stretch_tracks(board, f, dx, dy)
        p = f.GetPosition()
        f.SetPosition(pcbnew.VECTOR2I(p.x + dx, p.y + dy))
        moved.append(f'{f.GetReference()} {pcbnew.ToMM(dx):+.2f},{pcbnew.ToMM(dy):+.2f} mm')
    pcbnew.SaveBoard(main_board(cwd, stem), board)
    return 'Placement: move ' + '; '.join(moved)


def step_testpad(cwd, stem, rnd):
    """Add a test pad on a signal net, in free space near the middle of the board."""
    board = pcbnew.LoadBoard(main_board(cwd, stem))
    by_name = {}
    for f in board.GetFootprints():
        for p in f.Pads():
            n = p.GetNet()
            if n and n.GetNetname():
                by_name[n.GetNetname()] = n
    nets = [by_name[k] for k in sorted(by_name) if not re.search(r'GND|VCC|VDD|\+|-|unconnected', k)]
    net = rnd.choice(nets) if nets else None
    tp_refs = [f.GetReference() for f in board.GetFootprints() if f.GetReference().startswith('TP')]
    edge = board.GetBoardEdgesBoundingBox()
    c = (pcbnew.ToMM(edge.GetCenter().x), pcbnew.ToMM(edge.GetCenter().y))
    spot = None
    for radius in (0.9, 0.7, 0.55):
        try:
            spot = free_spot(board, c, radius=radius)
            break
        except SystemExit:
            continue
    if spot is None:
        return ''
    x, y = spot
    tp = pcbnew.PCB_IO_MGR.PluginFind(pcbnew.PCB_IO_MGR.KICAD_SEXP).FootprintLoad(FP_LIB, 'TestPoint_Pad_D1.0mm')
    tp.SetPosition(pcbnew.VECTOR2I(MM(x), MM(y)))
    n = max([int(re.sub(r'\D', '', r) or 0) for r in tp_refs] + [0]) + 1
    tp.SetReference(f'TP{n}')
    tp.SetValue('TestPoint')
    if net:
        for p in tp.Pads():
            p.SetNet(net)
    board.Add(tp)
    pcbnew.SaveBoard(main_board(cwd, stem), board)
    return f'add TP{n}' + (f' on {net.GetNetname()}' if net else '')


def step_remove(cwd, stem, rnd):
    """Remove one small part and the track stubs on its pads (last in its process: removals upset the bindings)."""
    board = pcbnew.LoadBoard(main_board(cwd, stem))
    cands = [f for f in board.GetFootprints() if re.match(r'^(C|R)\d+$', f.GetReference()) and len(f.Pads()) == 2]
    rnd.shuffle(cands)
    gone = cands[0]
    ref = gone.GetReference()
    pads = {(p.GetPosition().x, p.GetPosition().y) for p in gone.Pads()}
    doomed = [t for t in board.GetTracks() if t.GetClass() == 'PCB_TRACK' and ((t.GetStart().x, t.GetStart().y) in pads or (t.GetEnd().x, t.GetEnd().y) in pads)]
    for t in doomed:
        board.Remove(t)
    board.Remove(gone)
    pcbnew.SaveBoard(main_board(cwd, stem), board)
    return f'remove {ref}'


def step_routing(cwd, stem, rnd):
    board = pcbnew.LoadBoard(main_board(cwd, stem))
    counts = {}
    for t in board.GetTracks():
        if t.GetClass() == 'PCB_TRACK':
            counts[t.GetNetname()] = counts.get(t.GetNetname(), 0) + 1
    power = [n for n in counts if re.search(r'VCC|VDD|\+\d|\+5|\+3', n or '')] or sorted(counts, key=lambda n: -counts[n])[:1]
    net = power[0]
    for t in board.GetTracks():
        if t.GetClass() == 'PCB_TRACK' and t.GetNetname() == net:
            t.SetWidth(t.GetWidth() + MM(0.1))
    pcbnew.SaveBoard(main_board(cwd, stem), board)
    return f'Routing: widen {net} tracks by 0.1 mm ({counts[net]} segments)'


STEPS = {'values': step_values, 'move': step_move, 'testpad': step_testpad, 'remove': step_remove, 'routing': step_routing}


def run_step(step, cwd, stem, seed):
    """Each edit runs in its own process: pcbnew's bindings degrade after many loads in one interpreter."""
    r = subprocess.run([sys.executable, __file__, '--step', step, cwd, stem, seed], capture_output=True, text=True)
    lines = [l for l in r.stdout.splitlines() if l.startswith('MSG ')]
    if r.returncode or not lines and step != 'testpad':
        raise SystemExit(f'step {step} failed in {cwd}:\n{r.stderr[-2000:]}')
    return lines[-1][4:] if lines else ''


def build(out, name, folder, stem, description):
    src = os.path.join(DEMOS, folder)
    cwd = os.path.join(out, name)
    shutil.rmtree(cwd, ignore_errors=True)
    shutil.copytree(src, cwd)
    for b in boards(cwd):
        subprocess.run([sys.executable, '-c', f'import pcbnew; pcbnew.SaveBoard({b!r}, pcbnew.LoadBoard({b!r}))'], check=True, capture_output=True)
    v2 = os.path.join(cwd, stem + '_v2.kicad_pcb')
    v2_text = None
    if os.path.exists(v2):
        v2_text = open(v2, encoding='utf-8').read()
        for f in os.listdir(cwd):
            if f.startswith(stem + '_v2.'):
                os.remove(os.path.join(cwd, f))
    open(os.path.join(cwd, 'README.md'), 'w').write(
        f'# {description}\n\nThe `{folder}` demo project that ships with KiCad 9, with a few example edits on top so diffs and '
        f'reviews can be tried. The original project keeps its own licence.\n')
    git(cwd, 'init', '-q', '-b', 'main')
    git(cwd, 'config', 'user.name', 'Jumper Demo')
    git(cwd, 'config', 'user.email', 'demo@jumper.local')
    commit(cwd, f'Import the {folder} demo as shipped with KiCad 9', '2026-11-10T10:00:00')
    commit_msg = run_step('values', cwd, stem, name)
    commit(cwd, commit_msg, '2026-11-12T14:20:00')
    commit_msg = run_step('move', cwd, stem, name)
    commit(cwd, commit_msg, '2026-11-14T09:45:00')
    if v2_text:
        b = main_board(cwd, stem)
        open(b, 'w', encoding='utf-8').write(v2_text)
        subprocess.run([sys.executable, '-c', f'import pcbnew; pcbnew.SaveBoard({b!r}, pcbnew.LoadBoard({b!r}))'], check=True, capture_output=True)
        commit(cwd, 'Board revision 2 (the v2 layout KiCad ships for this project)', '2026-11-16T11:00:00')
    git(cwd, 'checkout', '-q', '-b', 'next')
    added = run_step('testpad', cwd, stem, name)
    commit_msg = 'Parts: ' + run_step('remove', cwd, stem, name) + (', ' + added if added else '')
    commit(cwd, commit_msg, '2026-11-18T16:10:00')
    commit_msg = run_step('routing', cwd, stem, name)
    commit(cwd, commit_msg, '2026-11-19T10:30:00')
    git(cwd, 'checkout', '-q', 'main')
    log = subprocess.run(['git', 'log', '--all', '--oneline'], cwd=cwd, capture_output=True, text=True).stdout
    print(f'{name}:\n{log}')


def main():
    if len(sys.argv) == 6 and sys.argv[1] == '--step':
        _, _, step, cwd, stem, seed = sys.argv
        print('MSG ' + STEPS[step](cwd, stem, random.Random(seed + step)))
        return
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for p in PROJECTS:
        build(out, *p)


if __name__ == '__main__':
    main()
