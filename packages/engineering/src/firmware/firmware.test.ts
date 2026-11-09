import { describe, expect, it } from 'vitest';
import { diffPinMaps, findPinConflicts, generatePinsCsv, generatePinsHeader, generateZephyrOverlay, netIdentifier, parseGpio } from '../index';

const pins = [
  { pin: 'PA5', net: '/SPI_SCK' },
  { pin: 'PB10', net: 'LED-1' },
  { pin: 'PC0', net: 'unconnected-(U1-PC0)' },
  { pin: 'BOOT0', net: 'BOOT0' },
];

describe('pin map', () => {
  it('parses STM32 and nRF pin names', () => {
    expect(parseGpio('PA5')).toEqual({ controller: 'gpioa', index: 5 });
    expect(parseGpio('P0.13')).toEqual({ controller: 'gpio0', index: 13 });
    expect(parseGpio('BOOT0')).toBeNull();
  });
  it('makes safe C identifiers', () => {
    expect(netIdentifier('/SPI_MOSI')).toBe('SPI_MOSI');
    expect(netIdentifier('+3V3')).toBe('P3V3');
    expect(netIdentifier('LED-1')).toBe('LED_1');
    expect(netIdentifier('1WIRE')).toBe('N_1WIRE');
    expect(netIdentifier('///')).toBe('NET');
  });
  it('generates a header skipping unconnected pins and noting non-GPIOs', () => {
    const h = generatePinsHeader(pins);
    expect(h).toContain('#define PIN_SPI_SCK 5');
    expect(h).toContain('#define PIN_LED_1 10');
    expect(h).not.toContain('PC0');
    expect(h).toContain('BOOT0: net BOOT0 (not a GPIO)');
  });
  it('generates a Zephyr overlay', () => {
    expect(generateZephyrOverlay(pins)).toContain('spi-sck-gpios = <&gpioa 5 GPIO_ACTIVE_HIGH>;');
  });
  it('disambiguates duplicate identifiers and escapes CSV', () => {
    const csv = generatePinsCsv([{ pin: 'PA1', net: 'X' }, { pin: 'PA2', net: 'X' }, { pin: 'PA3', net: 'A,B' }]);
    expect(csv).toContain('PA2,X,X_2');
    expect(csv).toContain('PA3,"A,B",A_B');
  });
  it('detects pin changes between revisions', () => {
    expect(diffPinMaps([{ pin: 'PA5', net: 'SCK' }, { pin: 'PA6', net: 'MISO' }], [{ pin: 'PA5', net: 'SCK2' }, { pin: 'PA7', net: 'X' }])).toEqual([
      { pin: 'PA5', before: 'SCK', after: 'SCK2' },
      { pin: 'PA6', before: 'MISO', after: null },
      { pin: 'PA7', before: null, after: 'X' },
    ]);
  });
  it('detects a pin tied to several nets', () => {
    expect(findPinConflicts([{ pin: 'PA1', net: 'A' }, { pin: 'PA1', net: 'B' }])).toHaveLength(1);
  });
});
