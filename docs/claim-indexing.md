# Credential Claim Indexing

## Overview

Credentials in Soroban Identity store their claims as a single opaque `Map<String, String>` blob in the contract's persistent storage. There is **no on-chain index** for individual claim keys or values. This design minimizes storage costs and contract complexity but means you cannot efficiently query "all credentials where `country=NG`" directly from the contract.

## Querying Claims: Two Approaches

### 1. Client-Side Filtering (Development/Small Scale)

The SDK provides `getCredentialsByClaimKey(subjectAddress, claimKey, claimValue)` which:

1. Fetches **all** credentials for the subject via `getCredentialsBySubject`
2. Deserializes every credential's claims map
3. Filters client-side for matching `claimKey` and `claimValue`

**Use this approach when:**
- Developing or testing with a small number of credentials (< 100 per subject)
- Off-chain infrastructure is not available
- One-off queries where performance is not critical

**Do NOT use this approach when:**
- Subjects have hundreds or thousands of credentials
- You need sub-second query response times
- You're building a production application with real user traffic

**Example:**

```typescript
import { CredentialClient, TESTNET_CONFIG } from '@soroban-identity/sdk';

const credentials = new CredentialClient({
  ...TESTNET_CONFIG,
  credentialManagerId: 'YOUR_CONTRACT_ID',
});

// Find all credentials where country=NG
const ngCreds = await credentials.getCredentialsByClaimKey(
  callerAddress,
  subjectAddress,
  'country',
  'NG'
);

console.log(`Found ${ngCreds.length} Nigerian credentials`);
```

**Performance Characteristics:**
- Time complexity: O(n) where n = total credentials for subject
- Network calls: 1 call to fetch IDs + n calls to fetch full credentials
- Memory: Holds all credentials in memory during filtering

### 2. Off-Chain Event Indexing (Production/Scale)

For production applications, implement an off-chain indexer that:

1. Listens to contract events (via Soroban RPC event streaming)
2. Extracts claim data from `credential.issued` events
3. Stores claims in a queryable database (PostgreSQL, MongoDB, etc.)
4. Provides a REST or GraphQL API for claim queries

**Architecture:**

```
Soroban RPC → Event Indexer → Database → Your API
                 ↓                ↓
           credential.issued    { 
             event logs          subject,
                                 claim_key,
                                 claim_value,
                                 credential_id
                               }
```

**Benefits:**
- Sub-second query times regardless of credential count
- Support for complex queries (e.g., "all subjects with `age > 21` AND `country=NG`")
- Minimal on-chain RPC load
- Can aggregate statistics across all subjects

**Implementation Steps:**

#### Step 1: Set Up Event Listener

Use the Soroban RPC `getEvents` method or the SDK's event streaming utilities to listen for `credential.issued` events:

```typescript
import { Server } from '@stellar/stellar-sdk';

const server = new Server('https://soroban-testnet.stellar.org');
const contractId = 'YOUR_CREDENTIAL_MANAGER_ID';

// Poll for new events
async function indexEvents() {
  const events = await server.getEvents({
    startLedger: lastIndexedLedger,
    filters: [{
      type: 'contract',
      contractIds: [contractId],
      topics: [['credential', 'issued']],
    }],
  });

  for (const event of events.events) {
    await processIssuedEvent(event);
  }
}
```

#### Step 2: Extract and Store Claims

Parse the event payload and store claim key-value pairs:

```typescript
import { scValToNative } from '@stellar/stellar-sdk';

async function processIssuedEvent(event) {
  const payload = scValToNative(event.value);
  
  const credentialId = payload.credential_id;
  const subject = payload.subject;
  const claims = payload.claims; // Map<String, String>
  
  // Store in your database
  for (const [key, value] of Object.entries(claims)) {
    await db.query(
      'INSERT INTO credential_claims (credential_id, subject, claim_key, claim_value) VALUES ($1, $2, $3, $4)',
      [credentialId, subject, key, value]
    );
  }
}
```

#### Step 3: Query Your Database

Provide efficient claim queries via your application layer:

```typescript
// Express.js example
app.get('/api/credentials/by-claim', async (req, res) => {
  const { subject, claimKey, claimValue } = req.query;
  
  const result = await db.query(
    `SELECT credential_id FROM credential_claims 
     WHERE subject = $1 AND claim_key = $2 AND claim_value = $3`,
    [subject, claimKey, claimValue]
  );
  
  res.json(result.rows);
});
```

## Contract Event Schema

The `credential-manager` contract emits the following event when a credential is issued:

**Topic:** `["credential", "issued"]`

**Payload:**

```rust
(
  event_version: u32,      // Currently 1
  credential_id: BytesN<32>,
  issuer: Address,
  subject: Address,
  credential_type: Symbol, // "Kyc", "Reputation", etc.
  claims: Map<String, String>,
  expires_at: u64
)
```

Use the SDK's event decoding utilities to parse this into a TypeScript object.

## Database Schema Example

A simple PostgreSQL schema for claim indexing:

```sql
CREATE TABLE credential_claims (
  id SERIAL PRIMARY KEY,
  credential_id VARCHAR(64) NOT NULL,
  subject VARCHAR(56) NOT NULL,
  issuer VARCHAR(56) NOT NULL,
  claim_key VARCHAR(256) NOT NULL,
  claim_value TEXT NOT NULL,
  issued_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP,
  
  INDEX idx_subject_claim (subject, claim_key, claim_value),
  INDEX idx_credential (credential_id),
  INDEX idx_issuer (issuer)
);
```

**Query examples:**

```sql
-- Find all credentials where country=NG
SELECT credential_id FROM credential_claims
WHERE subject = 'GABC...' AND claim_key = 'country' AND claim_value = 'NG';

-- Count subjects by country
SELECT claim_value AS country, COUNT(DISTINCT subject) AS count
FROM credential_claims
WHERE claim_key = 'country'
GROUP BY claim_value;

-- Find subjects with multiple claims
SELECT subject FROM credential_claims
WHERE claim_key = 'country' AND claim_value = 'NG'
  AND credential_id IN (
    SELECT credential_id FROM credential_claims
    WHERE claim_key = 'age' AND CAST(claim_value AS INTEGER) > 21
  );
```

## Future Enhancements

- **Zero-Knowledge Proofs:** Allow subjects to prove claim properties (e.g., "age > 21") without revealing the exact value
- **Claim Templates:** Pre-defined claim schemas with validation rules
- **On-Chain Bloom Filters:** Probabilistic claim existence checks without full indexing

## Related Issues

- [#560](https://github.com/fridaypetra55-afk/Soroban-Identity/issues/560) — Credential claim querying
- [#248](https://github.com/fridaypetra55-afk/Soroban-Identity/issues/248) — Pagination for large result sets

## References

- [Soroban Events Documentation](https://developers.stellar.org/docs/smart-contracts/getting-started/events)
- [W3C Verifiable Credentials Data Model](https://www.w3.org/TR/vc-data-model/)
