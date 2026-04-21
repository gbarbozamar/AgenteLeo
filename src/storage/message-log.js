/**
 * SQLite-backed message log for OpenClaw.
 *
 * Responsibilities:
 *   - Append inbound/outbound WhatsApp messages.
 *   - Query by JID or full-text (FTS5).
 *   - Track unread chats (messages received after the chat's read mark).
 *
 * Uses `better-sqlite3` (synchronous API) — the async method signatures here
 * are kept for ergonomic/future compatibility, but the underlying calls are
 * synchronous and fast.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  jid TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  text TEXT,
  media_type TEXT,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jid_ts ON messages(jid, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ts ON messages(ts DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  id UNINDEXED,
  text,
  content='messages',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, id, text) VALUES (new.rowid, new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, id, text) VALUES('delete', old.rowid, old.id, old.text);
END;
`;

export class MessageLog {
  /**
   * @param {object} opts
   * @param {string} opts.dbPath - Absolute path to the SQLite file.
   * @param {object} opts.logger - Pino-style logger.
   */
  constructor({ dbPath, logger }) {
    if (!dbPath) throw new Error('MessageLog: dbPath is required');
    if (!logger) throw new Error('MessageLog: logger is required');

    this.dbPath = dbPath;
    this.logger = logger;
    this.db = null;

    // Prepared statements, populated in init().
    this._stmts = null;
  }

  /**
   * Opens the DB, ensures the parent dir exists, creates tables and FTS.
   */
  async init() {
    const dir = path.dirname(this.dbPath);
    await fs.promises.mkdir(dir, { recursive: true });

    this.db = new Database(this.dbPath, { fileMustExist: false });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(SCHEMA_SQL);

    this._stmts = {
      insert: this.db.prepare(
        `INSERT OR IGNORE INTO messages (id, jid, from_me, ts, text, media_type)
         VALUES (@id, @jid, @from_me, @ts, @text, @media_type)`
      ),
      byJid: this.db.prepare(
        `SELECT * FROM messages WHERE jid = ? ORDER BY ts DESC LIMIT ?`
      ),
      recent: this.db.prepare(
        `SELECT * FROM messages ORDER BY ts DESC LIMIT ?`
      ),
      searchAny: this.db.prepare(
        `SELECT m.* FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
           WHERE messages_fts MATCH ?
           ORDER BY m.ts DESC
           LIMIT ?`
      ),
      searchByJid: this.db.prepare(
        `SELECT m.* FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
           WHERE messages_fts MATCH ? AND m.jid = ?
           ORDER BY m.ts DESC
           LIMIT ?`
      ),
      unread: this.db.prepare(
        `SELECT jid, COUNT(*) AS count, MAX(text) AS last_text, MAX(ts) AS last_ts
           FROM messages
          WHERE from_me = 0
            AND ts > ?
            AND (read_at IS NULL OR read_at < ts)
          GROUP BY jid
          ORDER BY last_ts DESC`
      ),
      markRead: this.db.prepare(
        `UPDATE messages SET read_at = ? WHERE jid = ?`
      ),
    };

    this.logger.info({ dbPath: this.dbPath }, 'MessageLog initialized');
  }

  _requireInit() {
    if (!this.db) throw new Error('MessageLog not initialized; call init() first');
  }

  /**
   * Appends a message. Duplicate ids are silently ignored.
   *
   * @param {object} msg
   * @param {string} msg.id
   * @param {string} msg.jid
   * @param {boolean|number} msg.fromMe
   * @param {number} msg.ts          - Epoch milliseconds.
   * @param {string} [msg.text]
   * @param {string} [msg.mediaType]
   */
  async append(msg) {
    this._requireInit();
    if (!msg || !msg.id || !msg.jid || msg.ts == null) {
      throw new Error('MessageLog.append: id, jid and ts are required');
    }
    try {
      this._stmts.insert.run({
        id: String(msg.id),
        jid: String(msg.jid),
        from_me: msg.fromMe ? 1 : 0,
        ts: Number(msg.ts),
        text: msg.text ?? null,
        media_type: msg.mediaType ?? null,
      });
    } catch (err) {
      this.logger.error({ err, id: msg.id }, 'MessageLog.append failed');
      throw err;
    }
  }

  /**
   * Query messages by JID and/or FTS query.
   *
   * @param {object} opts
   * @param {string} [opts.jid]
   * @param {number} [opts.limit=20]
   * @param {string} [opts.query]  - FTS5 match string.
   */
  async query({ jid, limit = 20, query } = {}) {
    this._requireInit();
    const cap = Math.max(1, Math.min(Number(limit) || 20, 500));

    try {
      if (query && query.trim()) {
        if (jid) return this._stmts.searchByJid.all(query, jid, cap);
        return this._stmts.searchAny.all(query, cap);
      }
      if (jid) return this._stmts.byJid.all(jid, cap);
      return this._stmts.recent.all(cap);
    } catch (err) {
      this.logger.error({ err, jid, query }, 'MessageLog.query failed');
      throw err;
    }
  }

  /**
   * Returns the most recent N messages across all chats.
   */
  async getRecent({ limit = 50 } = {}) {
    this._requireInit();
    const cap = Math.max(1, Math.min(Number(limit) || 50, 500));
    try {
      return this._stmts.recent.all(cap);
    } catch (err) {
      this.logger.error({ err }, 'MessageLog.getRecent failed');
      throw err;
    }
  }

  /**
   * Groups unread inbound messages by JID.
   *
   * @param {object} opts
   * @param {number} opts.since - Epoch ms; only messages with ts > since are considered.
   * @returns {Promise<Array<{ jid: string, count: number, last_text: string|null, last_ts: number }>>}
   */
  async getUnread({ since } = {}) {
    this._requireInit();
    if (since == null) throw new Error('MessageLog.getUnread: `since` is required');
    try {
      return this._stmts.unread.all(Number(since));
    } catch (err) {
      this.logger.error({ err, since }, 'MessageLog.getUnread failed');
      throw err;
    }
  }

  /**
   * Marks every message for `jid` as read (read_at = now).
   */
  async markChatRead(jid) {
    this._requireInit();
    if (!jid) throw new Error('MessageLog.markChatRead: jid is required');
    try {
      const info = this._stmts.markRead.run(Date.now(), jid);
      return { updated: info.changes };
    } catch (err) {
      this.logger.error({ err, jid }, 'MessageLog.markChatRead failed');
      throw err;
    }
  }

  /**
   * Closes the DB handle. Safe to call multiple times.
   */
  close() {
    if (this.db) {
      try {
        this.db.close();
        this.logger.info('MessageLog closed');
      } catch (err) {
        this.logger.error({ err }, 'MessageLog.close failed');
      } finally {
        this.db = null;
        this._stmts = null;
      }
    }
  }
}
