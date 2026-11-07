import { describe, expect, it } from 'vitest';
import { assertWebhookUrl, isPrivateAddress } from './ssrf';

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip'])('blocks %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('assertWebhookUrl', () => {
  it('requires https and public hosts by default', () => {
    expect(() => assertWebhookUrl('http://example.com/h', false)).toThrow(/https/);
    expect(() => assertWebhookUrl('https://localhost/h', false)).toThrow(/publicly/);
    expect(() => assertWebhookUrl('https://127.0.0.1/h', false)).toThrow(/publicly/);
    expect(() => assertWebhookUrl('https://[::1]/h', false)).toThrow(/publicly/);
    expect(() => assertWebhookUrl('https://metadata.internal/h', false)).toThrow(/publicly/);
    expect(assertWebhookUrl('https://hooks.example.com/h', false).hostname).toBe('hooks.example.com');
  });
  it('rejects odd schemes and embedded credentials', () => {
    expect(() => assertWebhookUrl('ftp://example.com', true)).toThrow(/http/);
    expect(() => assertWebhookUrl('file:///etc/passwd', true)).toThrow(/http/);
    expect(() => assertWebhookUrl('https://user:pw@example.com', true)).toThrow(/credentials/);
    expect(() => assertWebhookUrl('nonsense', true)).toThrow(/Invalid/);
  });
  it('allows private targets only when explicitly enabled', () => {
    expect(assertWebhookUrl('http://127.0.0.1:9000/h', true).port).toBe('9000');
  });
});
