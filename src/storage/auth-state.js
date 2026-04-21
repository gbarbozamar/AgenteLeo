/**
 * Baileys auth-state persistence.
 *
 * Persists multi-file auth credentials to disk so the WhatsApp session
 * survives restarts. On Railway, mount a volume at `/data` and set
 * AUTH_DIR=/data/auth so creds are stored on the persistent volume.
 */

import fs from 'fs/promises';
import path from 'path';
import { useMultiFileAuthState } from '@whiskeysockets/baileys';

/**
 * Ensures the auth directory exists and returns a loader function that
 * yields `{ state, saveCreds }` compatible with Baileys' `makeWASocket`.
 *
 * @param {object} opts
 * @param {string} opts.authDir - Absolute path to the auth directory.
 * @param {object} opts.logger  - Pino-style logger with `.info` / `.error`.
 * @returns {Promise<() => Promise<{ state: any, saveCreds: Function }>>}
 */
export async function createAuthStateLoader({ authDir, logger }) {
  if (!authDir) {
    throw new Error('createAuthStateLoader: authDir is required');
  }
  if (!logger) {
    throw new Error('createAuthStateLoader: logger is required');
  }

  await fs.mkdir(authDir, { recursive: true });
  logger.info({ authDir }, 'Auth state dir ready');

  return async function loadAuthState() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    return { state, saveCreds };
  };
}

/**
 * Deletes every file inside `authDir` (but keeps the directory itself).
 * Call this when the user wants to re-pair the device (e.g. because
 * the session is broken or belongs to a different phone).
 *
 * @param {string} authDir
 * @param {object} logger
 */
export async function clearAuthState(authDir, logger) {
  if (!authDir) {
    throw new Error('clearAuthState: authDir is required');
  }

  try {
    const entries = await fs.readdir(authDir);
    await Promise.all(
      entries.map((entry) =>
        fs.rm(path.join(authDir, entry), { recursive: true, force: true })
      )
    );
    logger?.info({ authDir, removed: entries.length }, 'Auth state cleared');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Directory didn't exist — nothing to clear.
      logger?.info({ authDir }, 'Auth state dir missing; nothing to clear');
      await fs.mkdir(authDir, { recursive: true });
      return;
    }
    logger?.error({ err, authDir }, 'Failed to clear auth state');
    throw err;
  }
}
