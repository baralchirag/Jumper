#!/usr/bin/env python3
"""
Build the homepage's live demo data: both revisions parsed and diffed by Jumper's own engine, and kicad-cli's 3D export
of Rev B.

Rev A is the RoyalBlue54L Feather exactly as KiCad ships it (CERN-OHL-P-2.0, Lord's Boards).
Rev B is the same example change as the hero images (see diff.py): J4 removed, SW3 added, D1 moved, R6 470R -> 1k,
two test pads on the SWD lines. The schematic is not edited, so DRC's schematic-parity check catches the mismatch,
exactly as it would on a real push.

Outputs (apps/web/src/features/home/live/assets/):
  demo.json.gz   both boards parsed and diffed ahead of time by Jumper's Rust core (pack.mjs), so the page shows the
                 demo as soon as ~1 MB arrives instead of downloading and parsing 7 MB of KiCad text in the browser
  rev-b.glb      kicad-cli's 3D export of Rev B with KiCad's real part models, compressed with meshopt

Requires KiCad 9 (kicad-cli + pcbnew Python module), Node, and network access for npx @gltf-transform/cli.
Usage: python3 scripts/hero-board/live.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
from diff import DEMO, NAME, make_rev_b  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'apps', 'web', 'src', 'features', 'home', 'live', 'assets')


def tag_parts(src, dst):
    """Name each part's uncoloured meshes `ref:<REF>` so the browser can finish them like the real part.

    kicad-cli drops the colours of many STEP models, leaving primitives with no material. The viewer gives those the
    finish their footprint implies, found through the part's node name (its reference), but gltf-transform's merging
    loses node names. A placeholder material per part survives it. Each gets a unique (unused) metallic value so
    dedup cannot fold different parts into one.
    """
    import struct
    data = open(src, 'rb').read()
    json_len, = struct.unpack_from('<I', data, 12)
    gltf = json.loads(data[20:20 + json_len])
    rest = data[20 + json_len:]
    refs = re.compile(r'^[A-Z]{1,4}\d+$')
    materials = gltf.setdefault('materials', [])
    tagged = {}

    def walk(i, ref):
        node = gltf['nodes'][i]
        name = node.get('name', '')
        ref = name if refs.match(name) else ref
        if ref and 'mesh' in node:
            for prim in gltf['meshes'][node['mesh']]['primitives']:
                if 'material' not in prim:
                    if ref not in tagged:
                        tagged[ref] = len(materials)
                        materials.append({'name': 'ref:' + ref, 'pbrMetallicRoughness': {
                            'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 1 - len(tagged) * 1e-4, 'roughnessFactor': 1}})
                    prim['material'] = tagged[ref]
        for c in node.get('children', []):
            walk(c, ref)

    for scene in gltf.get('scenes', []):
        for n in scene.get('nodes', []):
            walk(n, None)
    out = json.dumps(gltf, separators=(',', ':')).encode()
    out += b' ' * (-len(out) % 4)
    body = struct.pack('<II', len(out), 0x4E4F534A) + out + rest
    open(dst, 'wb').write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)
    return len(tagged)


def main():
    tmp = tempfile.mkdtemp(prefix='hero-live-')
    shutil.copytree(DEMO, tmp, dirs_exist_ok=True)
    a = os.path.join(tmp, NAME + '.kicad_pcb')
    b = os.path.join(tmp, 'rev-b.kicad_pcb')
    make_rev_b(a, b)

    os.makedirs(OUT, exist_ok=True)
    # Re-save Rev A through pcbnew: the copy shipped with some KiCad 9 packages has unbalanced parentheses in its
    # teardrop settings, which KiCad tolerates and a strict parser does not. Rev B is saved by pcbnew already.
    import pcbnew
    rev_a = os.path.join(tmp, 'pack-a.kicad_pcb')
    rev_b = os.path.join(tmp, 'pack-b.kicad_pcb')
    pcbnew.SaveBoard(rev_a, pcbnew.LoadBoard(os.path.join(DEMO, NAME + '.kicad_pcb')))
    shutil.copy(b, rev_b)
    # Model references stay: the browser's 3D view uses them to tell which parts are fitted and what they are.
    here = os.path.dirname(__file__)
    subprocess.run(['node', os.path.join(here, 'pack.mjs'), rev_a, rev_b, os.path.join(OUT, 'demo.json.gz')], check=True)

    # The 3D tab: KiCad's own export with real part models, then welded, simplified and meshopt-compressed
    # (13 MB -> under 1 MB). `b` still carries its model references and sits in the project directory.
    raw = os.path.join(tmp, 'rev-b.glb')
    # The demo references most models as ${KICAD8_3DMODEL_DIR}/....wrl. kicad-cli does not take that variable from the
    # environment and this library ships .step files only, so without a rewrite it silently drops every resistor,
    # capacitor and QFN. Point the references at the installed STEP files, as the worker does for user boards.
    models = os.environ.get('KICAD9_3DMODEL_DIR', '/usr/share/kicad/3dmodels')

    def fix(m):
        path = os.path.join(models, m.group(2))
        if path.endswith('.wrl') and not os.path.exists(path) and os.path.exists(path[:-4] + '.step'):
            path = path[:-4] + '.step'
        return m.group(1) + path + '"'

    text = open(b).read()
    open(b, 'w').write(re.sub(r'(\(model ")\$\{KICAD\d*_3DMODEL_DIR\}/([^"]+)"', fix, text))
    subprocess.run(['kicad-cli', 'pcb', 'export', 'glb', '--subst-models', '--include-tracks', '--include-pads',
                    '--include-zones', '--include-silkscreen', '--include-soldermask', '-f', '-o', raw, b], check=True,
                   stdout=subprocess.DEVNULL)
    tagged = os.path.join(tmp, 'rev-b.tagged.glb')
    tag_parts(raw, tagged)
    subprocess.run(['npx', '--yes', '@gltf-transform/cli@4.1.1', 'optimize', tagged, os.path.join(OUT, 'rev-b.glb'),
                    '--compress', 'meshopt', '--texture-compress', 'false', '--palette', 'false', '--simplify-error', '0.0004'], check=True)

    print('wrote', OUT)


if __name__ == '__main__':
    main()
