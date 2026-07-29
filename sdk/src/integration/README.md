# Integration Tests

This directory contains integration tests that run against a real local Soroban node using Docker's `stellar/quickstart` image.

## Purpose

Unlike unit tests that mock the RPC layer, integration tests:
- ✅ Catch serialization bugs
- ✅ Detect fee estimation errors
- ✅ Verify contract-SDK compatibility
- ✅ Test real transaction flows
- ✅ Validate error handling with actual contract responses

## Test Coverage

### Identity Tests (`identity.integration.test.ts`)
- DID creation with metadata
- DID resolution
- Duplicate DID prevention
- Active DID checking
- Storage statistics
- Complex metadata serialization

### Credentials Tests (`credentials.integration.test.ts`)
- Credential issuance
- Credential verification
- Credential revocation
- Expiration detection
- Complex claims structures
- Fee estimation
- Authorization checks
- Credential listing

### Reputation Tests (`reputation.integration.test.ts`)
- Rating submission
- Reputation score calculation
- Rating updates
- Rating queries by category
- Reputation history
- Self-rating prevention
- Authorization checks

## Prerequisites

### Required Software

1. **Docker** - For running stellar/quickstart
   ```bash
   docker --version
   ```

2. **Stellar CLI** - For contract deployment
   ```bash
   # Install via Homebrew (macOS/Linux)
   brew install stellar/tap/stellar-cli
   
   # Or download from GitHub releases
   # https://github.com/stellar/stellar-cli/releases
   
   stellar version
   ```

3. **Node.js 18+**
   ```bash
   node --version
   ```

## Running Tests

### Local Development

```bash
# From sdk directory
npm run test:integration
```

### Individual Test Files

```bash
# Run only identity tests
npx vitest run src/integration/identity.integration.test.ts --config vitest.integration.config.ts

# Run only credentials tests
npx vitest run src/integration/credentials.integration.test.ts --config vitest.integration.config.ts

# Run only reputation tests
npx vitest run src/integration/reputation.integration.test.ts --config vitest.integration.config.ts
```

### CI Environment

Integration tests run automatically:
- **Nightly**: Every day at 2 AM UTC
- **Manual**: Via GitHub Actions "Run workflow" button
- **Not on PRs**: To keep PR feedback fast (unit tests only)

View results: [Actions → Integration Tests](https://github.com/your-org/Soroban-Identity/actions/workflows/integration-tests.yml)

## How It Works

### Test Lifecycle

1. **Global Setup** (`beforeAll`)
   - Starts `stellar/quickstart:testing` Docker container
   - Waits for RPC server to be healthy
   - Deploys fresh contracts (identity, credentials, reputation)
   - Returns test environment configuration

2. **Test Execution**
   - Each test uses real Stellar SDK calls
   - Transactions are submitted to the local node
   - Contract state is persisted between tests
   - Tests run sequentially to avoid conflicts

3. **Global Teardown** (`afterAll`)
   - Stops and removes Docker container
   - Cleans up test artifacts

### Container Configuration

- **Image**: `stellar/quickstart:testing`
- **Mode**: Standalone (single-node network)
- **RPC Port**: 8000
- **Network**: Standalone Network ; February 2017
- **Container Name**: `soroban-identity-integration-test`

## Troubleshooting

### Docker Issues

**Container already exists:**
```bash
docker rm -f soroban-identity-integration-test
```

**Port 8000 in use:**
```bash
# Find and kill process using port 8000
lsof -ti:8000 | xargs kill -9
```

**Container not stopping:**
```bash
docker ps -a | grep soroban-identity
docker rm -f <container-id>
```

### Test Timeouts

Integration tests have extended timeouts:
- **Setup/teardown**: 120 seconds (2 minutes)
- **Individual tests**: 60 seconds (1 minute)

If tests timeout:
1. Check Docker is running: `docker ps`
2. Check RPC health: `curl http://localhost:8000/health`
3. Check container logs: `docker logs soroban-identity-integration-test`

### Contract Deployment Failures

If contracts fail to deploy:
1. Ensure `stellar` CLI is installed: `stellar version`
2. Check contract WASM files exist in `../contracts/target/`
3. Verify Docker container is running: `docker ps`

### RPC Connection Errors

If RPC connection fails:
1. Wait longer for container startup (may take 30-60 seconds)
2. Check container health: `docker exec soroban-identity-integration-test stellar rpc health`
3. Verify port mapping: `docker port soroban-identity-integration-test`

## Test Best Practices

### Writing New Tests

1. **Use fresh keypairs** for each test to avoid conflicts
   ```typescript
   const keypair = Keypair.random();
   ```

2. **Create DIDs first** before using them in credentials/reputation
   ```typescript
   await identityClient.createDid(keypair);
   ```

3. **Handle async properly** - all contract calls are async
   ```typescript
   const result = await client.issueCredential(...);
   expect(result.txHash).toBeTruthy();
   ```

4. **Test error cases** - verify proper error handling
   ```typescript
   await expect(client.createDid(keypair)).rejects.toThrow(/already exists/i);
   ```

5. **Add delays for consistency** when testing time-dependent behavior
   ```typescript
   await new Promise(resolve => setTimeout(resolve, 1000));
   ```

### What to Test

✅ **DO test:**
- Happy path flows
- Error conditions
- Edge cases (expiration, revocation, etc.)
- Serialization of complex data structures
- Authorization checks
- Fee handling

❌ **DON'T test:**
- Mock-able behavior (use unit tests)
- Internal SDK implementation details
- Contract implementation details

## Performance

### Typical Test Duration

- **Setup**: ~30-60 seconds (Docker start + contract deploy)
- **Identity tests**: ~10-20 seconds
- **Credentials tests**: ~20-30 seconds
- **Reputation tests**: ~15-25 seconds
- **Teardown**: ~5 seconds
- **Total**: ~5-10 minutes

### Optimization Tips

1. **Reuse DIDs** within test files where possible
2. **Run tests sequentially** to avoid Docker conflicts
3. **Batch operations** when testing multiple items
4. **Use smaller datasets** for list operations

## Debugging

### Enable Verbose Logging

```typescript
// In setup.ts, add console.log statements
console.log('[Integration] RPC URL:', env.rpcUrl);
console.log('[Integration] Contract IDs:', env);
```

### Inspect Container

```bash
# Access container shell
docker exec -it soroban-identity-integration-test sh

# View container logs
docker logs soroban-identity-integration-test

# Check RPC health
curl http://localhost:8000/health
```

### Run with Vitest UI

```bash
npx vitest --ui --config vitest.integration.config.ts
```

## Continuous Integration

### Workflow Configuration

File: `.github/workflows/integration-tests.yml`

**Triggers:**
- Nightly schedule (cron: `0 2 * * *`)
- Manual workflow dispatch

**Steps:**
1. Checkout code
2. Setup Node.js 18
3. Install dependencies
4. Install Stellar CLI
5. Pull Docker image
6. Run integration tests
7. Upload test results
8. Notify on failure (creates GitHub issue)

### Viewing Results

1. Go to GitHub Actions tab
2. Select "Integration Tests" workflow
3. View latest run or trigger manually

### Handling Failures

When nightly tests fail:
1. GitHub automatically creates an issue
2. Review test logs in Actions
3. Reproduce locally: `npm run test:integration`
4. Fix and verify
5. Close auto-generated issue

## Future Improvements

- [ ] Actual contract deployment from WASM files
- [ ] Support for multiple network configurations
- [ ] Parallel test execution with container pooling
- [ ] Performance benchmarking
- [ ] Integration with local Stellar development environment
- [ ] Snapshot testing for contract responses
- [ ] Test data generators for complex scenarios
