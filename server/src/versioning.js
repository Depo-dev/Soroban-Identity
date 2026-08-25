/**
 * API Versioning Strategy and Negotiation Module
 */

export const SUPPORTED_VERSIONS = ['v1', 'v2'];
export const DEFAULT_VERSION = 'v1';
export const DEPRECATED_VERSIONS = [];
export const SUNSET_DATE = '2027-12-31T23:59:59Z';
export const DEPRECATION_LINK = 'https://github.com/Soroban-Identity/docs/API_VERSIONING.md';

/**
 * Extract and resolve API version from URL pathname or Accept / Accept-Version headers.
 *
 * @param {object} req - HTTP request
 * @param {URL} url - Parsed URL
 * @returns {{ version: string, normalizedPath: string, isExplicitUrlVersion: boolean, isDeprecated: boolean }}
 */
export function resolveApiVersion(req, url) {
  let pathname = url.pathname;
  let version = null;
  let isExplicitUrlVersion = false;

  // 1. Check URL path prefix: /v1/... or /v2/...
  const urlMatch = pathname.match(/^\/(v[1-9][0-9]*)(?:\/|$)(.*)/);
  if (urlMatch) {
    const requestedUrlVer = urlMatch[1].toLowerCase();
    if (SUPPORTED_VERSIONS.includes(requestedUrlVer)) {
      version = requestedUrlVer;
      isExplicitUrlVersion = true;
      // Reconstruct normalized path without version prefix
      pathname = '/' + (urlMatch[2] || '');
      if (pathname.length > 1 && pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }
    }
  }

  // 2. Check Accept-Version header if not set in URL
  if (!version) {
    const acceptVersionHeader = req.headers['accept-version'];
    if (acceptVersionHeader) {
      const ver = acceptVersionHeader.trim().toLowerCase();
      const normalizedVer = ver.startsWith('v') ? ver : `v${ver}`;
      if (SUPPORTED_VERSIONS.includes(normalizedVer)) {
        version = normalizedVer;
      }
    }
  }

  // 3. Check Accept vendor header: application/vnd.soroban-identity.v1+json
  if (!version) {
    const acceptHeader = req.headers.accept || '';
    const vendorMatch = acceptHeader.match(/application\/vnd\.soroban-identity\.(v[1-9][0-9]*)\+json/i);
    if (vendorMatch) {
      const vendorVer = vendorMatch[1].toLowerCase();
      if (SUPPORTED_VERSIONS.includes(vendorVer)) {
        version = vendorVer;
      }
    }
  }

  // 4. Default fallback to DEFAULT_VERSION (v1)
  if (!version) {
    version = DEFAULT_VERSION;
  }

  const isDeprecated = DEPRECATED_VERSIONS.includes(version);

  return {
    version,
    normalizedPath: pathname || '/',
    isExplicitUrlVersion,
    isDeprecated,
  };
}

/**
 * Set API Version and Deprecation headers on response.
 *
 * @param {object} res - HTTP response
 * @param {object} versionInfo
 */
export function setVersionHeaders(res, { version, isDeprecated, isExplicitUrlVersion }) {
  res.setHeader('X-API-Version', version);
  res.setHeader('X-Supported-Versions', SUPPORTED_VERSIONS.join(', '));

  if (isDeprecated) {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', SUNSET_DATE);
    res.setHeader('Link', `<${DEPRECATION_LINK}>; rel="deprecation"`);
  }
}
