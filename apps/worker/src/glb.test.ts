import { describe, expect, it } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { optimizeKicadGlb } from './glb';

/** A tiny stand-in for kicad-cli's export: a coloured board and two parts whose models came without materials. */
async function sample(): Promise<Uint8Array> {
  const doc = new Document();
  const buf = doc.createBuffer();
  const tri = (dx: number) =>
    doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(new Float32Array([dx, 0, 0, dx + 1, 0, 0, dx, 1, 0])));
  const board = doc.createMaterial('mat_0').setBaseColorFactor([0.006, 0.185, 0.508, 1]);
  const scene = doc.createScene();
  scene.addChild(doc.createNode('board').setMesh(doc.createMesh().addPrimitive(tri(0).setMaterial(board))));
  for (const [ref, dx] of [['R6', 2], ['U1', 4]] as const) scene.addChild(doc.createNode(ref).addChild(doc.createNode('body').setMesh(doc.createMesh().addPrimitive(tri(dx)))));
  return new NodeIO().writeBinary(doc);
}

describe('optimizeKicadGlb', () => {
  it('compresses, keeps KiCad’s generator tag, and names each part’s uncoloured material after it', async () => {
    const out = await optimizeKicadGlb(await sample());
    await MeshoptDecoder.ready;
    const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder }).readBinary(out);
    const names = doc.getRoot().listMaterials().map((m) => m.getName()).sort();
    expect(names).toEqual(['mat_0', 'ref:R6', 'ref:U1']);
    // Read the tag from the file itself: gltf-transform's reader replaces it with its own name.
    const json = JSON.parse(new TextDecoder().decode(out.subarray(20, 20 + new DataView(out.buffer, out.byteOffset).getUint32(12, true)))) as { asset: { generator: string } };
    expect(json.asset.generator).toMatch(/open cascade/i);
    expect(doc.getRoot().listExtensionsUsed().map((e) => e.extensionName)).toContain('EXT_meshopt_compression');
    for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) expect(p.getMaterial()).not.toBeNull();
  });
});
