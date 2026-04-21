/**
 * Bearer token authentication middleware and per-token rate limiting for Express.
 *
 * Exports:
 *   - createBearerMiddleware({ expectedToken, logger })
 *   - createRateLimiter({ windowMs, max, logger })
 *   - generateToken(bytes)
 *
 * Run directly to print a fresh token:
 *   node src/security/auth.js
 */

import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import rateLimit from 'express-rate-limit';

/**
 * Perform a constant-time comparison between two strings.
 * Returns false quickly if lengths differ (the lengths themselves are not secret).
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Extract a bearer token from an Express request.
 * Checks the Authorization header (case-insensitive via Express's lowercased headers)
 * and falls back to the `token` query parameter (needed for browser <img> tags etc.).
 *
 * @param {import('express').Request} req
 * @returns {string | null}
 */
function extractToken(req) {
  // Express lowercases all incoming header names, so this is effectively case-insensitive.
  const authHeader = req.headers?.authorization;
  if (typeof authHeader === 'string' && authHeader.length > 0) {
    // Match "Bearer <token>" case-insensitively on the scheme.
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  const queryToken = req.query?.token;
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }

  return null;
}

/**
 * Create a bearer-token auth middleware.
 *
 * If `expectedToken` is falsy, the middleware becomes a pass-through after logging a single
 * loud warning at creation time. This is intended for local development only.
 *
 * @param {object} opts
 * @param {string} [opts.expectedToken] - The token required on incoming requests.
 * @param {import('pino').Logger} opts.logger - Pino logger instance.
 * @returns {import('express').RequestHandler}
 */
export function createBearerMiddleware({ expectedToken, logger } = {}) {
  if (!logger || typeof logger.warn !== 'function') {
    throw new Error('createBearerMiddleware requires a pino logger');
  }

  if (!expectedToken) {
    logger.warn(
      '*** SECURITY WARNING: bearer auth DISABLED (no expectedToken configured). ' +
        'All requests will pass through unauthenticated. DO NOT USE IN PRODUCTION. ***',
    );

    return function devPassthroughAuth(req, _res, next) {
      req.authenticated = false;
      next();
    };
  }

  // Rate-limit the warning log so a flood of bad tokens can't spam logs.
  // At most one warning log per IP per window.
  const warnWindowMs = 60_000;
  const warnMaxPerWindow = 1;
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const warnTracker = new Map();

  function shouldLogWarning(key) {
    const now = Date.now();
    const entry = warnTracker.get(key);
    if (!entry || entry.resetAt <= now) {
      warnTracker.set(key, { count: 1, resetAt: now + warnWindowMs });
      return true;
    }
    entry.count += 1;
    // Opportunistic cleanup to keep the map from growing unbounded.
    if (warnTracker.size > 1000) {
      for (const [k, v] of warnTracker) {
        if (v.resetAt <= now) warnTracker.delete(k);
      }
    }
    return entry.count <= warnMaxPerWindow;
  }

  return function bearerAuth(req, res, next) {
    const provided = extractToken(req);

    if (!provided) {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      if (shouldLogWarning(ip)) {
        logger.warn(
          { ip, path: req.path, method: req.method },
          'Auth failed: no bearer token provided',
        );
      }
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!timingSafeEqualStrings(provided, expectedToken)) {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      if (shouldLogWarning(ip)) {
        logger.warn(
          { ip, path: req.path, method: req.method },
          'Auth failed: invalid bearer token',
        );
      }
      return res.status(401).json({ error: 'Unauthorized' });
    }

    req.authenticated = true;
    return next();
  };
}

/**
 * Create a per-token (or per-IP fallback) rate limiter.
 *
 * @param {object} opts
 * @param {number} [opts.windowMs=60000] - Window size in ms.
 * @param {number} [opts.max=60]         - Max requests per key per window.
 * @param {import('pino').Logger} opts.logger - Pino logger instance.
 * @returns {import('express').RequestHandler}
 */
export function createRateLimiter({ windowMs = 60_000, max = 60, logger } = {}) {
  if (!logger || typeof logger.warn !== 'function') {
    throw new Error('createRateLimiter requires a pino logger');
  }

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req /*, _res */) => {
      const token = extractToken(req);
      if (token) {
        // Hash the token so it's not stored in memory or log lines in plaintext.
        return 'tok:' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
      }
      return 'ip:' + (req.ip || req.socket?.remoteAddress || 'unknown');
    },
    handler: (req, res /*, _next, options */) => {
      const retryAfter = Math.ceil(windowMs / 1000);
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      logger.warn(
        {
          ip,
          path: req.path,
          method: req.method,
          windowMs,
          max,
        },
        'Rate limit exceeded',
      );
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Rate limit exceeded', retryAfter });
    },
  });
}

/**
 * Generate a cryptographically-random hex token.
 * Default 32 bytes = 64 hex characters.
 *
 * @param {number} [bytes=32]
 * @returns {string}
 */
export function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

// ---------------------------------------------------------------------------
// CLI helper: `node src/security/auth.js` prints a fresh token.
// Guarded so this has no side effects when the module is imported.
// ---------------------------------------------------------------------------
if (
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const token = generateToken(32);
  // Plain stdout write — this is a CLI utility, not a running service, so pino
  // would be overkill and would add noise to the token output.
  process.stdout.write(token + '\n');
}
