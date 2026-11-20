import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { artifacts } from '@jumper/db';
import { artifactKey } from '@jumper/storage';
import { commitFiles, createHarness, dbAvailable, type Client, type Harness } from '../testing/harness';

const NETLIST = `(export (version "E")
  (components (comp (ref "U1") (value "STM32F103") (footprint "Package_QFP:LQFP-48")))
  (nets
    (net (code "1") (name "/USB_D+") (node (ref "U1") (pin "33") (pinfunction "PA12")))
    (net (code "2") (name "GND") (node (ref "U1") (pin "8")) (node (ref "C1") (pin "2")))))`;

describe.skipIf(!dbAvailable)('search', () => {
  let h: Harness;
  let alice: Client, bob: Client;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    alice = await h.user('alice');
    bob = await h.user('bob');
  });

  async function setup() {
    const pub = await h.repo(alice, 'usb-hub', { visibility: 'public' });
    const sha = await commitFiles(pub.git, { 'hw/usb-hub.kicad_sch': '(kicad_sch (lib_symbols "TPS2051"))', 'README.md': 'A four port USB hub with TPS2051 power switches' });
    const bom = JSON.stringify([
      { references: ['U2', 'U3'], quantity: 2, value: 'TPS2051', footprint: 'Package_TO_SOT_SMD:SOT-23-5', libId: 'Power:TPS2051', dnp: false, fields: { MPN: 'TPS2051BDBVR' } },
      { references: ['R1'], quantity: 1, value: '10k', footprint: 'Resistor_SMD:R_0603', libId: 'Device:R', dnp: false, fields: {} },
    ]);
    for (const [kind, name, body] of [['bom', 'bom.json', bom], ['netlist', 'netlist.net', NETLIST]] as const) {
      const key = artifactKey(pub.id, sha, 'hw/usb-hub.kicad_pro', name);
      await h.ctx.storage.put(key, Buffer.from(body), 'application/json');
      await h.ctx.db.insert(artifacts).values({ repoId: pub.id, sha, projectPath: 'hw/usb-hub.kicad_pro', kind, name, storageKey: key, contentType: 'application/json', size: body.length });
    }
    const priv = await h.repo(alice, 'secret-usb', { visibility: 'private' });
    await commitFiles(priv.git, { 'notes.txt': 'TPS2051 is used here too' });
    return { sha };
  }

  it('finds repositories, files, code, parts and nets', async () => {
    const { sha } = await setup();
    const repos = await bob.get('/api/search?q=usb&type=repos');
    expect(repos.json.hits.map((x: { repo: { name: string } }) => x.repo.name)).toEqual(['usb-hub']);

    const parts = await bob.get('/api/search?q=TPS2051&type=parts');
    expect(parts.json.hits).toEqual([expect.objectContaining({ type: 'parts', refs: ['U2', 'U3'], mpn: 'TPS2051BDBVR', quantity: 2, ref: sha })]);
    expect(parts.json.counts).toMatchObject({ parts: 1, code: 2 });

    const nets = await bob.get('/api/search?q=usb_d&type=nets');
    expect(nets.json.hits).toEqual([expect.objectContaining({ net: '/USB_D+', pads: 1 })]);

    const files = await bob.get('/api/repos/alice/usb-hub/search?q=usb-hub&type=files');
    expect(files.json.hits.map((x: { path: string }) => x.path)).toEqual(['hw/usb-hub.kicad_sch']);
    const code = await bob.get('/api/repos/alice/usb-hub/search?q=power switches&type=code');
    expect(code.json.hits).toEqual([expect.objectContaining({ path: 'README.md', line: 1 })]);
  });

  it('never shows private repositories to people without access', async () => {
    await setup();
    for (const type of ['repos', 'code', 'files']) {
      const res = await bob.get(`/api/search?q=${type === 'files' ? 'notes' : 'TPS2051'}&type=${type}`);
      expect(JSON.stringify(res.json.hits)).not.toContain('secret-usb');
      const anon = await h.anon.get(`/api/search?q=TPS2051&type=${type}`);
      expect(JSON.stringify(anon.json.hits)).not.toContain('secret-usb');
    }
    const own = await alice.get('/api/search?q=TPS2051&type=code');
    expect(own.json.hits.map((x: { repo: { name: string } }) => x.repo.name)).toContain('secret-usb');
    expect((await bob.get('/api/repos/alice/secret-usb/search?q=TPS')).status).toBe(404);
  });

  it('handles empty and odd queries', async () => {
    await setup();
    expect((await bob.get('/api/search?q=')).json.hits).toEqual([]);
    expect((await bob.get('/api/search?q=%25_%5C&type=repos')).status).toBe(200);
    expect((await bob.get('/api/repos/alice/usb-hub/search?q=-e&type=code')).status).toBe(200);
  });
});
