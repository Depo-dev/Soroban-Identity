# Contract Event Schema

This document defines the normalized event payload served by `GET /events` in the server package.

## SSE message shape

Each `contract-event` message includes:

- `id` (string): unique event identifier for stream clients
- `type` (string): Soroban event type (`contract`)
- `contractId` (string): emitting contract address
- `topic` (string[]): normalized event topic segments
- `value` (unknown): decoded event payload
- `ledger` (number): ledger sequence that emitted the event
- `txHash` (string): transaction hash
- `timestamp` (string): server timestamp (ISO 8601)

## identity-registry events

| Topic | Payload |
| --- | --- |
| `IDENTITY,created` | `[controller: string, timestamp: number]` |
| `IDENTITY,updated` | `[controller: string, metadataHash: string]` |
| `IDENTITY,deact` | `[controller: string, timestamp: number]` |
| `admin,xfer` | `[oldAdmin: string, newAdmin: string]` |

## credential-manager events

| Topic | Payload |
| --- | --- |
| `CRED,issued` | `[id: string, subject: string, issuer: string, credentialType: string]` |
| `CRED,revoked` | `[id: string, issuer: string]` |
| `CRED,evicted` | `[issuer: string, evictedId: string]` — emitted when the per-issuer credential ring buffer (`MAX_ISSUER_CREDS`) is full and the oldest entry is dropped to make room for a new one |

## reputation events

| Topic | Payload |
| --- | --- |
| `SCORE,updated` | `[subject: string, reporter: string, delta: number, score: number]` |

> The payload arrays are decoded from contract event values and reflect the contract tuple order.
