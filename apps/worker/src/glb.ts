import { Logger, NodeIO, type Document, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, flatten, join, meshopt, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

/**
 * kicad-cli's GLB export is large (often 10+ MB: every model's full tessellation) and leaves many parts without a
 * material. This shrinks it for the browser and keeps what the viewer needs to finish those parts like the real thing:
 *
 *  - Uncoloured meshes under a part's node get a placeholder material named `ref:<REF>` (one per part, each with a
 *    unique unused metallic value so dedup cannot fold different parts together). Mesh merging drops node names;
 *    the material name survives, and the viewer looks the part up on the parsed board to choose its finish.
 *  - dedup, weld, a gentle simplify (0.04 % of the model size), flatten and join, then meshopt compression.
 *  - The generator tag keeps "Open CASCADE", which tells the viewer the colours are KiCad's (sRGB in the linear slot).
 */
const REF = /^[A-Z]{1,4}\d+$/;

function tagParts(doc: Document): number {
  const root = doc.getRoot();
  const tagged = new Map<string, ReturnType<Document['createMaterial']>>();
  const walk = (node: Node, ref: string | null) => {
    const name = node.getName();
    const here = REF.test(name) ? name : ref;
    const mesh = node.getMesh();
    if (here && mesh) {
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMaterial()) continue;
        let m = tagged.get(here);
        if (!m) {
          m = doc
            .createMaterial(`ref:${here}`)
            .setBaseColorFactor([1, 1, 1, 1])
            .setMetallicFactor(1 - (tagged.size + 1) * 1e-4)
            .setRoughnessFactor(1);
          tagged.set(here, m);
        }
        prim.setMaterial(m);
      }
    }
    for (const child of node.listChildren()) walk(child, here);
  };
  for (const scene of root.listScenes()) for (const n of scene.listChildren()) walk(n, null);
  return tagged.size;
}

export async function optimizeKicadGlb(input: Uint8Array): Promise<Uint8Array> {
  await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const io = new NodeIO().setLogger(new Logger(Logger.Verbosity.WARN)).registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const doc = await io.readBinary(input);
  doc.setLogger(new Logger(Logger.Verbosity.WARN));
  tagParts(doc);
  await doc.transform(
    dedup(),
    prune(),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, error: 0.0004 }),
    flatten(),
    join(),
    dedup(),
    prune(),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  doc.getRoot().getAsset().generator = 'Open CASCADE (kicad-cli), compressed by Jumper';
  return io.writeBinary(doc);
}
