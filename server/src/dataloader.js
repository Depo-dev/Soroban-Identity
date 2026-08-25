import { readCredentials } from './storage.js';

/**
 * DataLoader implementation for batching and caching per-request data loading.
 */
export class DataLoader {
  constructor(batchFn, options = {}) {
    if (typeof batchFn !== 'function') {
      throw new TypeError('DataLoader must be constructed with a batch function.');
    }
    this._batchFn = batchFn;
    this._maxBatchSize = options.maxBatchSize || Infinity;
    this._cache = options.cache !== false ? new Map() : null;
    this._queue = [];
    this._scheduled = false;
  }

  /**
   * Load a single value by key.
   *
   * @param {*} key
   * @returns {Promise<*>}
   */
  load(key) {
    if (key === null || key === undefined) {
      return Promise.reject(new TypeError('The key to DataLoader.load() must not be null or undefined.'));
    }

    if (this._cache && this._cache.has(key)) {
      return this._cache.get(key);
    }

    const promise = new Promise((resolve, reject) => {
      this._queue.push({ key, resolve, reject });
      if (!this._scheduled) {
        this._scheduled = true;
        queueMicrotask(() => this._dispatchQueue());
      }
    });

    if (this._cache) {
      this._cache.set(key, promise);
    }

    return promise;
  }

  /**
   * Load multiple values by keys.
   *
   * @param {Array<*>} keys
   * @returns {Promise<Array<*>>}
   */
  loadMany(keys) {
    if (!Array.isArray(keys)) {
      return Promise.reject(new TypeError('The keys to DataLoader.loadMany() must be an Array.'));
    }
    return Promise.all(keys.map((key) => this.load(key)));
  }

  /**
   * Clears the value at key from the cache, if it exists.
   */
  clear(key) {
    if (this._cache) {
      this._cache.delete(key);
    }
    return this;
  }

  /**
   * Clears the entire cache.
   */
  clearAll() {
    if (this._cache) {
      this._cache.clear();
    }
    return this;
  }

  /**
   * Primes the cache with a key and value.
   */
  prime(key, value) {
    if (this._cache && !this._cache.has(key)) {
      const promise = value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      this._cache.set(key, promise);
    }
    return this;
  }

  async _dispatchQueue() {
    this._scheduled = false;
    const queue = this._queue;
    this._queue = [];
    if (queue.length === 0) return;

    const keys = queue.map((item) => item.key);
    try {
      const results = await this._batchFn(keys);
      if (!Array.isArray(results) || results.length !== keys.length) {
        throw new Error(
          `DataLoader batch function must return an array of equal length to keys. Expected ${keys.length}, received ${results?.length}`
        );
      }
      for (let i = 0; i < queue.length; i++) {
        const res = results[i];
        if (res instanceof Error) {
          queue[i].reject(res);
        } else {
          queue[i].resolve(res);
        }
      }
    } catch (err) {
      for (const item of queue) {
        item.reject(err);
      }
    }
  }
}

/**
 * Instantiate request-scoped DataLoaders for DIDs, Credentials, and Reputation.
 *
 * @param {object} context
 * @param {object} context.config
 * @param {object} [context.soroban]
 * @returns {object}
 */
export function createDataLoaders({ config, soroban }) {
  // Batch loader for Credentials
  const credentialLoader = new DataLoader(async (ids) => {
    const allCredentials = await readCredentials(config);
    const map = new Map(allCredentials.map((c) => [c.id, c]));
    return ids.map((id) => map.get(id) || null);
  });

  // Batch loader for DIDs
  const didLoader = new DataLoader(async (dids) => {
    return dids.map((did) => {
      const address = did.startsWith('did:stellar:') ? did.slice('did:stellar:'.length) : did;
      return {
        id: did.startsWith('did:stellar:') ? did : `did:stellar:${did}`,
        controller: `did:stellar:${address}`,
        verificationMethod: [
          {
            id: `did:stellar:${address}#keys-1`,
            type: 'Ed25519VerificationKey2020',
            controller: `did:stellar:${address}`,
            publicKeyMultibase: address,
          },
        ],
        authentication: [`did:stellar:${address}#keys-1`],
        assertionMethod: [`did:stellar:${address}#keys-1`],
        service: [
          {
            id: `did:stellar:${address}#identity-service`,
            type: 'IdentityHub',
            serviceEndpoint: 'https://identity.stellar.org/hub',
          },
        ],
      };
    });
  });

  // Batch loader for Reputation Scores
  const reputationLoader = new DataLoader(async (dids) => {
    const allCredentials = await readCredentials(config);
    return dids.map((did) => {
      const subject = did.startsWith('did:stellar:') ? did.slice('did:stellar:'.length) : did;
      const matchingCreds = allCredentials.filter(
        (c) => c.subject === subject || c.subject === did
      );
      const validCreds = matchingCreds.filter((c) => !c.revoked);
      const credentialCount = validCreds.length;
      const score = Math.min(100, credentialCount * 25 + 10);
      const tier = score >= 80 ? 'EXCELLENT' : score >= 50 ? 'GOOD' : score >= 25 ? 'FAIR' : 'NEW';

      return {
        did: did.startsWith('did:stellar:') ? did : `did:stellar:${did}`,
        score,
        tier,
        lastUpdated: new Date().toISOString(),
        breakdown: {
          credentialCount,
          activeDays: Math.min(365, credentialCount * 30),
          trustScore: Number((score / 100).toFixed(2)),
        },
      };
    });
  });

  return {
    credentialLoader,
    didLoader,
    reputationLoader,
  };
}
