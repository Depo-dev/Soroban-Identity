import { createHash } from 'node:crypto';
import type { DidDocument } from './types';

/**
 * Encode a credential claim value to a UTF-8 `Buffer`.
 *
 * Fix for #332: prior code paths used `Buffer.from(value, 'ascii')` which
 * silently replaced every non-ASCII codepoint (accented Latin, CJK, Arabic,
 * etc.) with `0x3F` (`?`), corrupting the credential payload and causing
 * on-chain hash mismatches. This helper centralises the encoding so every
 * serialisation path consistently uses UTF-8.
 *
 * @param value The claim value string to encode.
 * @returns A `Buffer` containing the UTF-8 byte representation of `value`.
 */
export function serializeClaimValue(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

/**
 * Compute a deterministic SHA-256 hash over a flat `string → string` claims
 * map for off-chain verification.
 *
 * Keys are sorted alphabetically before hashing so the result is independent
 * of insertion order. Each key and value is encoded as UTF-8 bytes (see
 * {@link serializeClaimValue}) to preserve non-ASCII characters.
 *
 * Fix for #332: the previous implementation used `Buffer.from(value, 'ascii')`
 * which corrupted non-ASCII subject names (e.g. `André Müller`), producing a
 * hash that never matched the on-chain record.
 *
 * @param claims Flat `string → string` claims object (output of
 *               {@link flattenSubject} or a credential's `claims` field).
 * @returns 64-character lowercase hex SHA-256 digest.
 *
 * @example
 * const hash = hashSubjectClaims({ name: 'André Müller', country: 'DE' });
 * // hash matches the on-chain claimsHash for the same credential
 */
export function hashSubjectClaims(claims: Record<string, string>): string {
  const h = createHash('sha256');
  for (const key of Object.keys(claims).sort()) {
    h.update(serializeClaimValue(key));
    h.update(serializeClaimValue(claims[key]!));
  }
  return h.digest('hex');
}

/**
 * Flatten a nested object into dot-notation keys, matching the on-chain XDR
 * encoding used by the credential-manager contract.
 *
 * @example
 * flattenSubject({ address: { city: 'NYC', zip: '10001' }, name: 'Alice' })
 * // => { 'address.city': 'NYC', 'address.zip': '10001', name: 'Alice' }
 *
 * @param obj    The object to flatten (may be arbitrarily nested).
 * @param prefix Dot-notation prefix accumulated during recursion.
 * @returns A new flat `Record<string, string>` with dot-separated keys.
 */
export function flattenSubject(
  obj: Record<string, unknown>,
  prefix = ''
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenSubject(value as Record<string, unknown>, fullKey));
    } else {
      // Use String() coercion — values are stored as utf-8 on-chain; see
      // serializeClaimValue() for the byte-level encoding used during hashing.
      result[fullKey] = String(value ?? '');
    }
  }
  return result;
}

/**
 * Convert a Soroban-Identity {@link DidDocument} into a W3C DID Core 1.0
 * JSON-LD shape.
 *
 * Each metadata entry is mapped to a `service` object using `LinkedDomains` as
 * the type. The contract does not track verification methods, so that array is
 * always empty.
 *
 * @param doc DID document as returned by {@link IdentityClient.resolveDid}.
 * @returns A plain object conforming to the W3C DID Core 1.0 shape.
 */
export function toW3CDidDocument(doc: DidDocument): object {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: doc.id,
    controller: doc.controller,
    verificationMethod: [],
    service: Object.entries(doc.metadata).map(([id, serviceEndpoint]) => ({
      id: `${doc.id}#${id}`,
      type: 'LinkedDomains',
      serviceEndpoint,
    })),
  };
}

/**
 * Convenience wrapper around {@link toW3CDidDocument} that returns a
 * 2-space-indented JSON-LD string ready for file output or HTTP response.
 *
 * @param doc DID document to serialise.
 * @returns Pretty-printed JSON-LD string.
 */
export function exportDidDocumentAsJsonLd(doc: DidDocument): string {
  return JSON.stringify(toW3CDidDocument(doc), null, 2);
}
