# Soroban Identity - 50 Unique Issues

This document contains 50 carefully crafted issues across Frontend, Backend, Contracts, Bugs, and API categories.

## Issue Breakdown

- **Frontend Issues:** 10
- **Backend/Server Issues:** 10
- **Smart Contract Issues:** 10
- **Bug Issues:** 10
- **API Issues:** 10

---

## FRONTEND ISSUES (10)

### 1. [Frontend] Implement dark mode theme toggle
**Labels:** `frontend`, `enhancement`, `ui/ux`  
**Priority:** Medium

Add a dark mode theme toggle to the frontend application with persistent user preference storage.

**Requirements:**
- [ ] Create theme context provider
- [ ] Add toggle button in navigation
- [ ] Store preference in localStorage
- [ ] Apply consistent color scheme across all components
- [ ] Ensure WCAG AA contrast compliance in both themes

---

### 2. [Frontend] Add loading skeletons for async content
**Labels:** `frontend`, `enhancement`, `ui/ux`  
**Priority:** Low

Replace loading spinners with skeleton screens for better perceived performance.

**Requirements:**
- [ ] Design skeleton components for DID cards
- [ ] Add skeletons for credential lists
- [ ] Implement reputation score skeleton
- [ ] Add shimmer animation effect
- [ ] Test with slow network conditions

---

### 3. [Frontend] Implement responsive mobile navigation
**Labels:** `frontend`, `enhancement`, `mobile`  
**Priority:** High

Create a mobile-friendly hamburger menu navigation system for screens below 768px.

**Requirements:**
- [ ] Design mobile navigation drawer
- [ ] Add hamburger menu icon
- [ ] Implement smooth open/close animations
- [ ] Ensure touch-friendly button sizes (min 44x44px)
- [ ] Test on iOS and Android devices

---

### 4. [Frontend] Add credential verification status indicators
**Labels:** `frontend`, `enhancement`, `credentials`  
**Priority:** High

Display visual indicators for credential verification states (valid, expired, revoked, pending).

**Requirements:**
- [ ] Design status badge components
- [ ] Add color-coded indicators (green=valid, red=revoked, yellow=expired)
- [ ] Include tooltips with detailed status information
- [ ] Add timestamp for last verification check
- [ ] Implement auto-refresh for status changes

---

### 5. [Frontend] Implement wallet connection retry mechanism
**Labels:** `frontend`, `enhancement`, `wallet`  
**Priority:** Medium

Add automatic retry logic when Freighter wallet connection fails or times out.

**Requirements:**
- [ ] Detect connection failures
- [ ] Implement exponential backoff retry (3 attempts max)
- [ ] Show user-friendly error messages
- [ ] Add manual reconnect button
- [ ] Log connection attempts for debugging

---

### 6. [Frontend] Create comprehensive form validation
**Labels:** `frontend`, `enhancement`, `validation`  
**Priority:** High

Implement client-side validation for all form inputs with real-time feedback.

**Requirements:**
- [ ] Validate DID creation metadata fields
- [ ] Add Stellar address format validation
- [ ] Implement credential claim validation
- [ ] Show inline error messages
- [ ] Add success/error toast notifications
- [ ] Prevent duplicate form submissions

---

### 7. [Frontend] Add pagination for credential lists
**Labels:** `frontend`, `enhancement`, `performance`  
**Priority:** Medium

Implement pagination for large credential lists to improve performance and UX.

**Requirements:**
- [ ] Add page size selector (10, 25, 50, 100)
- [ ] Implement previous/next navigation
- [ ] Show total count and current page info
- [ ] Add jump-to-page functionality
- [ ] Maintain pagination state in URL params

---

### 8. [Frontend] Implement search and filter for DIDs
**Labels:** `frontend`, `enhancement`, `search`  
**Priority:** Medium

Add search functionality to filter DIDs by address, metadata, or credential types.

**Requirements:**
- [ ] Create search input component
- [ ] Implement real-time search filtering
- [ ] Add filter dropdowns (credential type, status, date)
- [ ] Show result count
- [ ] Add clear filters button
- [ ] Debounce search input

---

### 9. [Frontend] Add QR code generation for DIDs
**Labels:** `frontend`, `enhancement`, `feature`  
**Priority:** Low

Generate QR codes for DIDs to enable easy sharing and mobile scanning.

**Requirements:**
- [ ] Integrate QR code library (e.g., qrcode.react)
- [ ] Generate QR from DID string
- [ ] Add download QR code as PNG
- [ ] Add copy DID to clipboard button
- [ ] Display in modal or card view

---

### 10. [Frontend] Implement accessibility improvements (A11y)
**Labels:** `frontend`, `enhancement`, `accessibility`  
**Priority:** High

Enhance accessibility compliance to meet WCAG 2.1 Level AA standards.

**Requirements:**
- [ ] Add proper ARIA labels to all interactive elements
- [ ] Ensure keyboard navigation for all features
- [ ] Add skip-to-content link
- [ ] Implement focus visible indicators
- [ ] Test with screen readers (NVDA, JAWS)
- [ ] Add alt text for all images
- [ ] Ensure form labels are properly associated

---

## BACKEND/SERVER ISSUES (10)

### 11. [Backend] Implement rate limiting for API endpoints
**Labels:** `backend`, `enhancement`, `security`  
**Priority:** High

Add rate limiting middleware to prevent abuse and ensure fair usage of API endpoints.

**Requirements:**
- [ ] Implement rate limiting using express-rate-limit or similar
- [ ] Set limits: 100 req/15min for general endpoints, 10 req/15min for credential issuance
- [ ] Return 429 status with retry-after header
- [ ] Add rate limit info in response headers
- [ ] Whitelist trusted IPs if needed
- [ ] Log rate limit violations

---

### 12. [Backend] Add comprehensive API request logging
**Labels:** `backend`, `enhancement`, `observability`  
**Priority:** Medium

Implement structured logging for all API requests with correlation IDs and performance metrics.

**Requirements:**
- [ ] Log request method, path, status, duration
- [ ] Generate or accept X-Request-ID headers
- [ ] Include user agent and IP address
- [ ] Log request/response payloads (excluding sensitive data)
- [ ] Integrate with log aggregation service (e.g., Winston, Pino)
- [ ] Add log rotation policy

---

### 13. [Backend] Implement Redis caching for DID resolution
**Labels:** `backend`, `enhancement`, `performance`  
**Priority:** High

Add Redis caching layer for frequently resolved DIDs to reduce RPC calls and improve response times.

**Requirements:**
- [ ] Set up Redis connection with retry logic
- [ ] Cache DID documents with TTL (default 60s)
- [ ] Implement cache invalidation on DID updates
- [ ] Add cache hit/miss metrics
- [ ] Handle cache connection failures gracefully
- [ ] Add cache warming for popular DIDs

---

### 14. [Backend] Add health check endpoint with detailed status
**Labels:** `backend`, `enhancement`, `devops`  
**Priority:** High

Create comprehensive health check endpoint for monitoring service and dependency health.

**Requirements:**
- [ ] Implement GET /health endpoint
- [ ] Check database connectivity
- [ ] Check RPC endpoint availability
- [ ] Check Redis connection (if enabled)
- [ ] Return detailed status for each dependency
- [ ] Add /ready endpoint for Kubernetes readiness probes
- [ ] Include version and uptime information

---

### 15. [Backend] Implement credential expiry notification system
**Labels:** `backend`, `enhancement`, `feature`  
**Priority:** Medium

Create background job to check for expiring credentials and send notifications.

**Requirements:**
- [ ] Set up scheduled job (e.g., node-cron)
- [ ] Query credentials expiring within 7/3/1 days
- [ ] Send email notifications to credential holders
- [ ] Add webhook support for external integrations
- [ ] Log notification attempts and failures
- [ ] Add configuration for notification thresholds

---

### 16. [Backend] Add Prometheus metrics export endpoint
**Labels:** `backend`, `enhancement`, `observability`  
**Priority:** Medium

Expose Prometheus-compatible metrics endpoint for monitoring and alerting.

**Requirements:**
- [ ] Integrate prom-client library
- [ ] Expose GET /metrics endpoint
- [ ] Track API request count and duration
- [ ] Monitor credential issuance/verification counts
- [ ] Add custom business metrics (active DIDs, credential types)
- [ ] Include Node.js runtime metrics
- [ ] Document metric names and labels

---

### 17. [Backend] Implement API request validation middleware
**Labels:** `backend`, `enhancement`, `validation`  
**Priority:** High

Add comprehensive request validation using Joi or Zod schemas for all endpoints.

**Requirements:**
- [ ] Define validation schemas for all endpoints
- [ ] Validate request body, query params, and headers
- [ ] Return detailed 400 error responses with field-level errors
- [ ] Add sanitization for string inputs
- [ ] Validate Stellar address formats
- [ ] Add custom validators for DID and credential IDs

---

### 18. [Backend] Add CORS configuration flexibility
**Labels:** `backend`, `enhancement`, `configuration`  
**Priority:** Medium

Implement configurable CORS settings via environment variables for different deployment environments.

**Requirements:**
- [ ] Add CORS_ORIGIN environment variable
- [ ] Support multiple origins (comma-separated)
- [ ] Add CORS_CREDENTIALS flag
- [ ] Configure allowed methods and headers
- [ ] Add preflight request caching
- [ ] Document CORS configuration in README

---

### 19. [Backend] Implement WebSocket support for real-time updates
**Labels:** `backend`, `enhancement`, `feature`  
**Priority:** Low

Add WebSocket server for real-time credential verification status updates and DID changes.

**Requirements:**
- [ ] Set up Socket.io or ws server
- [ ] Create rooms for DID-specific subscriptions
- [ ] Emit events on credential status changes
- [ ] Emit events on DID updates
- [ ] Add authentication for WebSocket connections
- [ ] Handle reconnection logic
- [ ] Add rate limiting for WebSocket messages

---

### 20. [Backend] Add database backup and restore scripts
**Labels:** `backend`, `enhancement`, `devops`  
**Priority:** Medium

Create automated scripts for backing up and restoring application data and configurations.

**Requirements:**
- [ ] Create backup script for Redis data
- [ ] Backup environment configurations
- [ ] Add timestamped backup file naming
- [ ] Implement restore functionality
- [ ] Schedule automated daily backups
- [ ] Add backup retention policy (keep last 30 days)
- [ ] Test restore procedure

---

## SMART CONTRACT ISSUES (10)

### 21. [Contracts] Add batch DID creation function
**Labels:** `contracts`, `enhancement`, `optimization`  
**Priority:** Medium

Implement batch operation to create multiple DIDs in a single transaction for gas efficiency.

**Requirements:**
- [ ] Add create_dids_batch function to identity-registry
- [ ] Accept vector of (controller, metadata) tuples
- [ ] Validate all inputs before processing
- [ ] Emit events for each DID created
- [ ] Add size limit (max 50 DIDs per batch)
- [ ] Return vector of created DID identifiers
- [ ] Update SDK and tests

---

### 22. [Contracts] Implement credential delegation mechanism
**Labels:** `contracts`, `enhancement`, `feature`  
**Priority:** Low

Allow credential holders to delegate verification rights to third parties temporarily.

**Requirements:**
- [ ] Add delegation storage in credential-manager
- [ ] Implement delegate_verification function
- [ ] Add expiry time for delegations
- [ ] Allow revocation of delegations
- [ ] Emit delegation events
- [ ] Update verification logic to check delegations
- [ ] Add tests for delegation scenarios

---

### 23. [Contracts] Add credential type registry and validation
**Labels:** `contracts`, `enhancement`, `validation`  
**Priority:** High

Create a registry of valid credential types with schemas for structured validation.

**Requirements:**
- [ ] Add credential type registry in credential-manager
- [ ] Admin function to register new credential types
- [ ] Associate JSON schemas with types
- [ ] Validate claims against schema during issuance
- [ ] Query available credential types
- [ ] Add type-specific metadata
- [ ] Update documentation with type definitions

---

### 24. [Contracts] Implement reputation score decay mechanism
**Labels:** `contracts`, `enhancement`, `reputation`  
**Priority:** Medium

Add time-based decay to reputation scores to favor recent activity over historical data.

**Requirements:**
- [ ] Add decay_rate parameter to reputation contract
- [ ] Calculate decayed score based on time since last activity
- [ ] Update get_reputation to return current decayed score
- [ ] Add decay configuration per reporter
- [ ] Implement linear or exponential decay options
- [ ] Update tests for decay scenarios

---

### 25. [Contracts] Add multi-signature support for admin operations
**Labels:** `contracts`, `enhancement`, `security`  
**Priority:** High

Require multiple signatures for critical admin operations like adding issuers or reporters.

**Requirements:**
- [ ] Implement multi-sig admin storage
- [ ] Add propose_admin_action function
- [ ] Add approve_admin_action function
- [ ] Set threshold (e.g., 2-of-3, 3-of-5)
- [ ] Execute action when threshold met
- [ ] Add timeout for pending proposals
- [ ] Emit events for proposal lifecycle

---

### 26. [Contracts] Implement credential proof requirements
**Labels:** `contracts`, `enhancement`, `security`  
**Priority:** High

Add support for requiring proof of possession before credential issuance.

**Requirements:**
- [ ] Add challenge generation for credential requests
- [ ] Verify signed challenges before issuance
- [ ] Support Ed25519 and secp256k1 signatures
- [ ] Add challenge expiry (5 minutes)
- [ ] Store challenge state temporarily
- [ ] Update issue_credential to require proof
- [ ] Add tests for proof verification

---

### 27. [Contracts] Add pausable contract functionality
**Labels:** `contracts`, `enhancement`, `security`  
**Priority:** High

Implement emergency pause mechanism for all contracts to halt operations during security incidents.

**Requirements:**
- [ ] Add paused state flag to each contract
- [ ] Implement pause() and unpause() admin functions
- [ ] Add whenNotPaused modifier to critical functions
- [ ] Allow read operations during pause
- [ ] Emit Paused/Unpaused events
- [ ] Update tests for paused state
- [ ] Document emergency procedures

---

### 28. [Contracts] Optimize storage for gas efficiency
**Labels:** `contracts`, `enhancement`, `optimization`  
**Priority:** Low

Analyze and optimize contract storage patterns to reduce gas costs for common operations.

**Requirements:**
- [ ] Audit current storage usage patterns
- [ ] Use packed storage where possible
- [ ] Remove redundant data storage
- [ ] Optimize map key types
- [ ] Benchmark gas costs before/after
- [ ] Document storage layout
- [ ] Update tests to verify functionality

---

### 29. [Contracts] Add credential metadata indexing
**Labels:** `contracts`, `enhancement`, `feature`  
**Priority:** Medium

Implement indexing for credential metadata to enable efficient querying by attributes.

**Requirements:**
- [ ] Add secondary indices for common query patterns
- [ ] Index by credential type
- [ ] Index by issuer address
- [ ] Index by subject address
- [ ] Add range query support for timestamps
- [ ] Implement paginated query functions
- [ ] Optimize for read performance

---

### 30. [Contracts] Implement upgrade mechanism for contracts
**Labels:** `contracts`, `enhancement`, `architecture`  
**Priority:** High

Add upgrade capability to allow contract logic updates without losing state.

**Requirements:**
- [ ] Implement proxy pattern or similar upgrade mechanism
- [ ] Separate storage from logic contracts
- [ ] Add upgrade authorization checks
- [ ] Implement migration functions for state changes
- [ ] Test upgrade scenarios thoroughly
- [ ] Add timelock for upgrade proposals
- [ ] Document upgrade procedures

---

## BUG ISSUES (10)

### 31. [Bug] Freighter wallet connection fails on Firefox
**Labels:** `bug`, `frontend`, `wallet`  
**Priority:** High

Users report that Freighter wallet connection button is unresponsive on Firefox browser.

**Steps to Reproduce:**
1. Open application in Firefox (version 120+)
2. Click "Connect Wallet" button
3. Observe no Freighter popup appears

**Expected Behavior:** Freighter wallet popup should appear prompting user to connect

**Actual Behavior:** Button click has no effect, no error in console

**Environment:**
- Browser: Firefox 120+
- OS: Windows 10/11
- Freighter version: Latest

**Possible Cause:** Browser-specific API compatibility issue

---

### 32. [Bug] DID metadata not updating after successful transaction
**Labels:** `bug`, `frontend`, `did`  
**Priority:** Medium

After calling update_did and receiving successful transaction, the UI still shows old metadata.

**Steps to Reproduce:**
1. Create a DID with initial metadata
2. Call update_did with new metadata
3. Wait for transaction confirmation
4. Refresh DID view

**Expected Behavior:** Updated metadata should be displayed

**Actual Behavior:** Old metadata persists until page refresh

**Possible Cause:** Cache invalidation issue or state not updating after transaction

---

### 33. [Bug] Credential verification fails for valid non-expired credentials
**Labels:** `bug`, `contracts`, `credentials`  
**Priority:** Critical

verify_credential returns false for credentials that are not revoked and not expired.

**Steps to Reproduce:**
1. Issue a valid credential with expiry in future
2. Immediately call verify_credential
3. Observe false return value

**Expected Behavior:** Should return true for valid credential

**Actual Behavior:** Returns false

**Environment:**
- Contract: credential-manager v0.1.0
- Network: Testnet

---

### 34. [Bug] Race condition in reputation score updates
**Labels:** `bug`, `contracts`, `reputation`  
**Priority:** High

Concurrent score submissions from multiple reporters sometimes result in incorrect final scores.

**Steps to Reproduce:**
1. Have 3 reporters submit scores simultaneously
2. Query final reputation score
3. Observe score doesn't match sum of deltas

**Expected Behavior:** Final score should be sum of all submitted deltas

**Actual Behavior:** Some score updates are lost

**Possible Cause:** Race condition in score aggregation logic without proper locking

---

### 35. [Bug] Server crashes on malformed SSE event data
**Labels:** `bug`, `backend`, `sse`  
**Priority:** High

Server throws unhandled exception when contract emits malformed event data via SSE stream.

**Steps to Reproduce:**
1. Subscribe to /events SSE endpoint
2. Trigger contract event with unexpected payload format
3. Observe server crash

**Expected Behavior:** Server should handle malformed data gracefully and log error

**Actual Behavior:** Server crashes and requires restart

---

### 36. [Bug] Memory leak in SDK credential polling
**Labels:** `bug`, `sdk`, `memory-leak`  
**Priority:** Medium

CredentialClient continuously polls for status updates without cleanup, causing memory leak.

**Steps to Reproduce:**
1. Create CredentialClient instance
2. Call verifyCredential repeatedly (100+ times)
3. Monitor memory usage
4. Observe steadily increasing memory consumption

**Expected Behavior:** Memory usage should remain stable

**Actual Behavior:** Memory increases by ~5MB per 100 calls

**Possible Cause:** Event listeners or timers not being cleared

---

### 37. [Bug] DID resolution returns 404 for newly created DIDs
**Labels:** `bug`, `backend`, `did`  
**Priority:** Medium

Calling resolveDid immediately after createDid returns 404 error.

**Steps to Reproduce:**
1. Call createDid for new address
2. Immediately call resolveDid with same address
3. Observe 404 response

**Expected Behavior:** Should return newly created DID document

**Actual Behavior:** Returns 404, works after 5-10 second delay

**Possible Cause:** RPC propagation delay or caching issue

---

### 38. [Bug] Mobile viewport layout breaks on small screens
**Labels:** `bug`, `frontend`, `mobile`, `ui/ux`  
**Priority:** Medium

UI elements overlap and become unusable on devices with width < 375px.

**Steps to Reproduce:**
1. Open app on iPhone SE or similar small device (320px width)
2. Navigate to credential verification page
3. Observe overlapping buttons and text

**Expected Behavior:** UI should be responsive and usable on all mobile devices

**Actual Behavior:** Elements overlap, buttons inaccessible

**Environment:**
- Device: iPhone SE (320x568)
- Browser: Safari Mobile

---

### 39. [Bug] Expired credentials still showing as valid in UI
**Labels:** `bug`, `frontend`, `credentials`  
**Priority:** High

Frontend displays expired credentials with green "Valid" badge instead of yellow "Expired" badge.

**Steps to Reproduce:**
1. Issue credential with expiry in past
2. View credential in frontend
3. Observe green "Valid" status

**Expected Behavior:** Should show yellow "Expired" badge

**Actual Behavior:** Shows green "Valid" badge

**Possible Cause:** Frontend not checking expiry timestamp, only revocation status

---

### 40. [Bug] Deploy script fails with 503 errors on testnet
**Labels:** `bug`, `devops`, `deployment`  
**Priority:** High

deploy.sh script fails intermittently with 503 Service Unavailable errors from RPC endpoint.

**Steps to Reproduce:**
1. Run bash scripts/deploy.sh
2. Observe failure during contract deployment
3. Error: "503 Service Unavailable"

**Expected Behavior:** Script should retry on transient errors

**Actual Behavior:** Script exits immediately on first error

**Possible Solution:** Add retry logic with exponential backoff

---

## API ISSUES (10)

### 41. [API] Add OpenAPI spec for credential endpoints
**Labels:** `api`, `documentation`  
**Priority:** Medium

Complete OpenAPI specification is missing detailed documentation for credential-related endpoints.

**Requirements:**
- [ ] Document POST /credentials/issue endpoint
- [ ] Document GET /credentials/:id endpoint
- [ ] Document POST /credentials/:id/verify endpoint
- [ ] Document DELETE /credentials/:id/revoke endpoint
- [ ] Add request/response examples
- [ ] Document error responses
- [ ] Add authentication requirements

---

### 42. [API] Implement API versioning strategy
**Labels:** `api`, `enhancement`, `architecture`  
**Priority:** High

Add API versioning to allow backward-compatible changes and smooth migrations.

**Requirements:**
- [ ] Implement URL-based versioning (/v1/, /v2/)
- [ ] Update all endpoints to include version prefix
- [ ] Add version negotiation via Accept header
- [ ] Maintain v1 for backward compatibility
- [ ] Document deprecation policy
- [ ] Add version info to health endpoint

---

### 43. [API] Add GraphQL endpoint for flexible querying
**Labels:** `api`, `enhancement`, `feature`  
**Priority:** Low

Provide GraphQL API alongside REST for clients needing flexible data fetching.

**Requirements:**
- [ ] Set up Apollo Server or similar
- [ ] Define schema for DIDs, Credentials, Reputation
- [ ] Implement resolvers
- [ ] Add DataLoader for batch/caching
- [ ] Enable GraphQL playground in dev mode
- [ ] Document GraphQL schema
- [ ] Add authentication to GraphQL endpoint

---

### 44. [API] Implement webhook delivery system
**Labels:** `api`, `enhancement`, `feature`  
**Priority:** Medium

Allow clients to register webhook URLs for credential and DID event notifications.

**Requirements:**
- [ ] Add webhook registration endpoint
- [ ] Store webhook URLs with auth tokens
- [ ] Implement delivery queue (e.g., Bull, Bee-Queue)
- [ ] Retry failed deliveries with exponential backoff
- [ ] Add webhook signature verification (HMAC)
- [ ] Provide webhook event logs
- [ ] Add webhook testing endpoint

---

### 45. [API] Add bulk credential verification endpoint
**Labels:** `api`, `enhancement`, `feature`  
**Priority:** Medium

Create endpoint to verify multiple credentials in a single request for efficiency.

**Requirements:**
- [ ] Implement POST /credentials/verify/batch endpoint
- [ ] Accept array of credential IDs
- [ ] Return array of verification results
- [ ] Set limit of 50 credentials per request
- [ ] Add partial success handling
- [ ] Document in OpenAPI spec

---

### 46. [API] Implement API key authentication
**Labels:** `api`, `enhancement`, `security`  
**Priority:** High

Add API key authentication for server-to-server integrations.

**Requirements:**
- [ ] Generate API keys with configurable permissions
- [ ] Store hashed API keys securely
- [ ] Implement X-API-Key header validation
- [ ] Add rate limiting per API key
- [ ] Provide API key management endpoints
- [ ] Add key rotation mechanism
- [ ] Document authentication in OpenAPI spec

---

### 47. [API] Add credential expiry reminder webhook
**Labels:** `api`, `enhancement`, `notifications`  
**Priority:** Low

Send webhook notifications when credentials are approaching expiry.

**Requirements:**
- [ ] Check credentials expiring in 30/7/1 days
- [ ] Send webhook to registered URLs
- [ ] Include credential details and expiry date
- [ ] Add snooze/dismiss functionality
- [ ] Log notification delivery status
- [ ] Allow configuration of reminder thresholds

---

### 48. [API] Implement request throttling based on user tier
**Labels:** `api`, `enhancement`, `monetization`  
**Priority:** Low

Add tiered rate limiting based on user subscription level (free, pro, enterprise).

**Requirements:**
- [ ] Define rate limit tiers
- [ ] Store user tier in authentication context
- [ ] Apply tier-specific limits
- [ ] Return tier info in response headers
- [ ] Add upgrade prompts for free tier
- [ ] Document tier limits in API docs

---

### 49. [API] Add API analytics and usage dashboard
**Labels:** `api`, `enhancement`, `observability`  
**Priority:** Low

Create dashboard to monitor API usage, popular endpoints, and error rates.

**Requirements:**
- [ ] Track requests per endpoint
- [ ] Monitor response times and errors
- [ ] Show top consumers by API key
- [ ] Display geographic distribution
- [ ] Add real-time usage graphs
- [ ] Export analytics data (CSV, JSON)

---

### 50. [API] Implement content negotiation for multiple response formats
**Labels:** `api`, `enhancement`, `feature`  
**Priority:** Low

Support multiple response formats (JSON, XML, YAML) based on Accept header.

**Requirements:**
- [ ] Implement Accept header parsing
- [ ] Add JSON response formatter (default)
- [ ] Add XML response formatter
- [ ] Add YAML response formatter
- [ ] Return 406 for unsupported formats
- [ ] Document supported formats in API docs

---

## How to Create These Issues

### Option 1: Using GitHub CLI (gh)
```bash
# Install GitHub CLI if not already installed
# Then run this in the repository root:

gh issue create --title "Issue Title" --body "Issue Description" --label "label1,label2"
```

### Option 2: Using the PowerShell Script
1. Open `create-issues.ps1`
2. Add your GitHub Personal Access Token (create at https://github.com/settings/tokens)
3. Uncomment the creation code
4. Run: `.\create-issues.ps1`

### Option 3: Manual Creation
Copy and paste each issue into GitHub's issue creation form at:
https://github.com/Faisat-Creator/Soro-Chain/issues/new

---

## Labels to Create

Before creating issues, ensure these labels exist in your repository:
- `frontend`, `backend`, `contracts`, `api`, `sdk`
- `bug`, `enhancement`, `feature`
- `ui/ux`, `mobile`, `accessibility`
- `security`, `performance`, `validation`
- `documentation`, `devops`, `observability`
- `wallet`, `did`, `credentials`, `reputation`
- `high-priority`, `medium-priority`, `low-priority`
