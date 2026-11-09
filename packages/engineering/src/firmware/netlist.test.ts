import { describe, expect, it } from 'vitest';
import { candidateMcus, parseNetlist, parseSexpr, pinAssignments } from '../index';

const NET = `(export (version "E")
  (components
    (comp (ref "U1") (value "STM32F103") (footprint "Package_QFP:LQFP-48"))
    (comp (ref "R1") (value "10k") (footprint "R_0603")))
  (nets
    (net (code "1") (name "/SPI_SCK") (class "Default")
      (node (ref "U1") (pin "15") (pinfunction "PA5") (pintype "bidirectional"))
      (node (ref "R1") (pin "1") (pintype "passive")))
    (net (code "2") (name "GND")
      (node (ref "U1") (pin "8") (pinfunction "VSS") (pintype "power_in")))))`;

describe('netlist', () => {
  it('parses components and nets', () => {
    const n = parseNetlist(NET);
    expect(n.components.map((c) => c.ref)).toEqual(['U1', 'R1']);
    expect(n.nets[0]).toMatchObject({ name: '/SPI_SCK' });
    expect(n.nets[0]!.nodes[0]).toMatchObject({ ref: 'U1', pin: '15', pinFunction: 'PA5' });
  });
  it('extracts pin assignments for one component, using pin functions', () => {
    expect(pinAssignments(parseNetlist(NET), 'U1')).toEqual([{ pin: 'PA5', net: '/SPI_SCK' }, { pin: 'VSS', net: 'GND' }]);
  });
  it('handles quoted escapes', () => {
    expect(parseSexpr('(a "b\\"c")')).toEqual([['a', 'b"c']]);
  });
  it('rejects malformed and non-netlist input', () => {
    expect(() => parseSexpr('(a (b)')).toThrow(/unbalanced/);
    expect(() => parseSexpr('a)')).toThrow(/unbalanced/);
    expect(() => parseSexpr('(a "x')).toThrow(/unterminated/);
    expect(() => parseNetlist('(kicad_sch)')).toThrow(/not a KiCad netlist/);
  });
  it('bounds nesting depth', () => {
    expect(() => parseSexpr('('.repeat(5000) + ')'.repeat(5000))).toThrow(/too deep/);
  });
  it('suggests MCU candidates only for U* parts with many pins', () => {
    const many = `(export (components (comp (ref "U2") (value "MCU")) (comp (ref "U3") (value "LDO"))) (nets ${Array.from({ length: 10 }, (_, i) => `(net (name "N${i}") (node (ref "U2") (pin "${i}")))`).join('')} (net (name "X") (node (ref "U3") (pin "1")))))`;
    expect(candidateMcus(parseNetlist(many)).map((c) => c.ref)).toEqual(['U2']);
  });
});
