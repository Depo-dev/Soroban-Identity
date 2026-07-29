import { describe, it, expect } from 'vitest';
import { toW3CDidDocument, exportDidDocumentAsJsonLd } from './serializers';
import type { DidDocument } from './types';

const mockDoc: DidDocument = {
  id: 'did:stellar:GABC1234567890',
  controller: 'GABC1234567890',
  metadata: { website: 'https://example.com', twitter: 'https://twitter.com/example' },
  createdAt: 1000000,
  updatedAt: 1000001,
  active: true,
};

describe('toW3CDidDocument', () => {
  it('includes the W3C DID context', () => {
    const result = toW3CDidDocument(mockDoc) as any;
    expect(result['@context']).toEqual(['https://www.w3.org/ns/did/v1']);
  });

  it('sets id from doc.id', () => {
    const result = toW3CDidDocument(mockDoc) as any;
    expect(result.id).toBe('did:stellar:GABC1234567890');
  });

  it('sets controller from doc.controller', () => {
    const result = toW3CDidDocument(mockDoc) as any;
    expect(result.controller).toBe('GABC1234567890');
  });

  it('maps metadata entries to service array', () => {
    const result = toW3CDidDocument(mockDoc) as any;
    expect(result.service).toHaveLength(2);
    expect(result.service[0]).toMatchObject({
      id: 'did:stellar:GABC1234567890#website',
      type: 'LinkedDomains',
      serviceEndpoint: 'https://example.com',
    });
  });

  it('produces empty service array when metadata is empty', () => {
    const doc = { ...mockDoc, metadata: {} };
    const result = toW3CDidDocument(doc) as any;
    expect(result.service).toEqual([]);
  });

  it('includes an empty verificationMethod array', () => {
    const result = toW3CDidDocument(mockDoc) as any;
    expect(result.verificationMethod).toEqual([]);
  });
});

describe('exportDidDocumentAsJsonLd', () => {
  it('returns a valid JSON string', () => {
    const output = exportDidDocumentAsJsonLd(mockDoc);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('parsed output contains @context field', () => {
    const parsed = JSON.parse(exportDidDocumentAsJsonLd(mockDoc));
    expect(parsed['@context']).toEqual(['https://www.w3.org/ns/did/v1']);
  });

  it('parsed output contains correct id', () => {
    const parsed = JSON.parse(exportDidDocumentAsJsonLd(mockDoc));
    expect(parsed.id).toBe('did:stellar:GABC1234567890');
  });

  it('parsed output contains correct controller', () => {
    const parsed = JSON.parse(exportDidDocumentAsJsonLd(mockDoc));
    expect(parsed.controller).toBe('GABC1234567890');
  });

  it('output is pretty-printed with 2-space indent', () => {
    const output = exportDidDocumentAsJsonLd(mockDoc);
    expect(output).toContain('\n  ');
  });
});

import { flattenSubject } from './serializers';

// ─── #420 — flattenSubject regression ─────────────────────────────────────────

describe('flattenSubject (#420)', () => {
  it('passes flat string subjects through unchanged', () => {
    const input = { name: 'Alice', country: 'US' };
    expect(flattenSubject(input)).toEqual({ name: 'Alice', country: 'US' });
  });

  it('flattens one level of nesting using dot-notation keys', () => {
    const input = { address: { city: 'NYC', zip: '10001' } };
    expect(flattenSubject(input)).toEqual({
      'address.city': 'NYC',
      'address.zip': '10001',
    });
  });

  it('flattens two levels of nesting', () => {
    const input = {
      contact: { address: { city: 'Berlin', country: 'DE' } },
    };
    expect(flattenSubject(input)).toEqual({
      'contact.address.city': 'Berlin',
      'contact.address.country': 'DE',
    });
  });

  it('mixes flat and nested fields', () => {
    const input = {
      name: 'Bob',
      address: { city: 'Paris' },
    };
    expect(flattenSubject(input)).toEqual({
      name: 'Bob',
      'address.city': 'Paris',
    });
  });

  it('produces identical output for flat subjects as direct key access', () => {
    const flat = { role: 'admin', level: '2' };
    expect(flattenSubject(flat)).toEqual(flat);
  });

  it('converts non-string leaf values to strings', () => {
    // Credentials claims are string→string on-chain, so numeric values must
    // be coerced the same way the contract does.
    const input = { score: 42, active: true } as unknown as Record<string, unknown>;
    const result = flattenSubject(input);
    expect(result['score']).toBe('42');
    expect(result['active']).toBe('true');
  });
});

import { serializeClaimValue, hashSubjectClaims } from './serializers';
import { createHash } from 'node:crypto';

// ─── #332 — UTF-8 encoding in serializeClaimValue / hashSubjectClaims ─────────

describe('serializeClaimValue (#332)', () => {
  it('returns a Buffer', () => {
    expect(Buffer.isBuffer(serializeClaimValue('hello'))).toBe(true);
  });

  it('encodes ASCII strings correctly', () => {
    expect(serializeClaimValue('hello')).toEqual(Buffer.from('hello', 'utf8'));
  });

  it('preserves accented Latin characters — not corrupted to 0x3F', () => {
    const buf = serializeClaimValue('André');
    // 0x3F is '?' — the replacement character produced by ascii encoding
    expect(buf.includes(0x3f)).toBe(false);
    expect(buf).toEqual(Buffer.from('André', 'utf8'));
  });

  it('preserves CJK characters', () => {
    const buf = serializeClaimValue('北京');
    expect(buf.includes(0x3f)).toBe(false);
    expect(buf).toEqual(Buffer.from('北京', 'utf8'));
  });

  it('preserves Arabic characters', () => {
    const buf = serializeClaimValue('مرحبا');
    expect(buf.includes(0x3f)).toBe(false);
    expect(buf).toEqual(Buffer.from('مرحبا', 'utf8'));
  });

  it('roundtrips to the original string via utf8', () => {
    const original = 'Ünïcödé';
    expect(serializeClaimValue(original).toString('utf8')).toBe(original);
  });
});

describe('hashSubjectClaims (#332)', () => {
  it('returns a 64-character hex string', () => {
    const hash = hashSubjectClaims({ name: 'Alice', country: 'US' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic regardless of key insertion order', () => {
    const h1 = hashSubjectClaims({ name: 'Alice', country: 'US' });
    const h2 = hashSubjectClaims({ country: 'US', name: 'Alice' });
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different values', () => {
    const h1 = hashSubjectClaims({ name: 'Alice' });
    const h2 = hashSubjectClaims({ name: 'Bob' });
    expect(h1).not.toBe(h2);
  });

  it('correctly hashes non-ASCII names — fix for #332', () => {
    // With ascii encoding 'André Müller' would be corrupted to 'Andr? M?ller'.
    // The hash computed here must match what a correct UTF-8 implementation
    // would produce, and must NOT match a hash computed over the corrupted
    // ascii-encoded bytes.
    const correctHash = hashSubjectClaims({ name: 'André Müller' });

    // Simulate the old broken ascii path
    const h = createHash('sha256');
    h.update(Buffer.from('name', 'ascii'));
    h.update(Buffer.from('André Müller', 'ascii'));
    const corruptedHash = h.digest('hex');

    expect(correctHash).not.toBe(corruptedHash);

    // And it must equal the expected utf-8 hash
    const h2 = createHash('sha256');
    h2.update(Buffer.from('name', 'utf8'));
    h2.update(Buffer.from('André Müller', 'utf8'));
    expect(correctHash).toBe(h2.digest('hex'));
  });

  it('hashes an empty claims object to a consistent value', () => {
    const h1 = hashSubjectClaims({});
    const h2 = hashSubjectClaims({});
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
