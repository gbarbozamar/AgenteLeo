// OpenClaw MCP tool definitions — wraps WhatsApp client + message log.
// ESM module. No side effects at import time.
//
// Uses Zod schemas (required by @modelcontextprotocol/sdk v1.29+).
//
// Expected dependencies (injected via buildTools):
//   waClient:   { sendText, sendVoice, sendImage, sendDocument,
//                 listChats, getMessages, markRead, isReady }
//   messageLog: { query({ jid, limit, query? }),
//                 getRecent({ limit }),
//                 getUnread({ since }) }
//   logger:     { info, warn, error, debug }
//   ownerJid:   string — the only recipient initially allowed for send-tools.

import { z } from 'zod';

const PROCESS_START = Date.now();

// --- Utilities ----------------------------------------------------------

function normalizeJid(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (s.includes('@')) return s;
  const digits = s.replace(/\D+/g, '');
  if (!digits) return '';
  return `${digits}@s.whatsapp.net`;
}

function okResponse(payload) {
  return {
    content: [
      { type: 'text', text: JSON.stringify({ ok: true, ...payload }) },
    ],
  };
}

function errorResponse(message, extra = {}) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: false, error: message, ...extra }),
      },
    ],
    isError: true,
  };
}

function wrap(logger, toolName, fn) {
  return async (args = {}) => {
    logger.info(`[mcp:${toolName}] invoked`, {
      tool: toolName,
      args: redactArgs(args),
    });
    try {
      const result = await fn(args);
      logger.debug(`[mcp:${toolName}] ok`);
      return result;
    } catch (err) {
      logger.error(`[mcp:${toolName}] failed`, {
        tool: toolName,
        error: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : undefined,
      });
      return errorResponse(err && err.message ? err.message : String(err));
    }
  };
}

function redactArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === 'string' && /_base64$/.test(k)) {
      out[k] = `[base64 ${v.length} chars]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function assertAllowedRecipient({ to, ownerJid, logger, toolName }) {
  if (process.env.WA_ALLOW_ANY === 'true') return null;

  const normTarget = normalizeJid(to);
  const normOwner = normalizeJid(ownerJid);

  if (!normTarget) {
    return errorResponse(
      'Missing or invalid "to". Provide a phone number in international format (+5491112345678) or a JID.',
    );
  }
  if (!normOwner) {
    return errorResponse(
      'Server is misconfigured: ownerJid is not set. Cannot validate recipient allowlist.',
    );
  }
  if (normTarget !== normOwner) {
    logger.warn(`[mcp:${toolName}] recipient blocked by allowlist`, {
      tool: toolName,
      target: normTarget,
      owner: normOwner,
    });
    return errorResponse(
      'Target not allowed. Set WA_ALLOW_ANY=true or add to allowlist.',
      { target: normTarget },
    );
  }
  return null;
}

function decodeBase64(b64, fieldName) {
  if (typeof b64 !== 'string' || b64.length === 0) {
    throw new Error(`"${fieldName}" must be a non-empty base64 string.`);
  }
  const cleaned = b64.replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(cleaned, 'base64');
  if (buf.length === 0) {
    throw new Error(`"${fieldName}" decoded to zero bytes — invalid base64?`);
  }
  return buf;
}

function isOggOpus(buffer) {
  if (!buffer || buffer.length < 4) return false;
  return (
    buffer[0] === 0x4f &&
    buffer[1] === 0x67 &&
    buffer[2] === 0x67 &&
    buffer[3] === 0x53
  );
}

// --- Tool definitions --------------------------------------------------

export function buildTools({ waClient, messageLog, logger, ownerJid }) {
  if (!waClient) throw new Error('buildTools: waClient is required');
  if (!messageLog) throw new Error('buildTools: messageLog is required');
  if (!logger) throw new Error('buildTools: logger is required');

  const guard = (toolName, to) =>
    assertAllowedRecipient({ to, ownerJid, logger, toolName });

  const tools = [
    // -------------------------------------------------------- 1: wa_send_text
    {
      name: 'wa_send_text',
      description: 'Send a plain text WhatsApp message to a contact.',
      inputSchema: {
        to: z.string().describe('Phone number in international format (+5491112345678) or JID'),
        text: z.string().describe('Message text'),
      },
      handler: wrap(logger, 'wa_send_text', async ({ to, text }) => {
        const blocked = guard('wa_send_text', to);
        if (blocked) return blocked;
        if (typeof text !== 'string' || text.length === 0) {
          return errorResponse('"text" must be a non-empty string.');
        }
        const result = await waClient.sendText(to, text);
        return okResponse({ result });
      }),
    },

    // -------------------------------------------------------- 2: wa_send_voice
    {
      name: 'wa_send_voice',
      description:
        'Send a voice note. Audio MUST be ogg/opus encoded (Opus in Ogg container).',
      inputSchema: {
        to: z.string().describe('Phone number in international format or JID'),
        audio_base64: z.string().describe(
          'Base64-encoded ogg/opus audio. Must begin with Ogg magic bytes "OggS".',
        ),
        transcript: z.string().optional().describe(
          'Optional human-readable transcript for logging.',
        ),
      },
      handler: wrap(
        logger,
        'wa_send_voice',
        async ({ to, audio_base64, transcript }) => {
          const blocked = guard('wa_send_voice', to);
          if (blocked) return blocked;

          const buf = decodeBase64(audio_base64, 'audio_base64');
          if (!isOggOpus(buf)) {
            return errorResponse(
              'Audio is not ogg/opus. Expected magic bytes "OggS" at offset 0. ' +
                'Please re-encode with ffmpeg (e.g. `ffmpeg -i in.wav -c:a libopus -b:a 32k out.ogg`) before sending.',
            );
          }
          const result = await waClient.sendVoice(to, buf, { transcript });
          return okResponse({
            result,
            bytes: buf.length,
            transcript: transcript || null,
          });
        },
      ),
    },

    // -------------------------------------------------------- 3: wa_send_image
    {
      name: 'wa_send_image',
      description: 'Send an image (optionally with a caption).',
      inputSchema: {
        to: z.string().describe('Phone number in international format or JID'),
        image_base64: z.string().describe('Base64-encoded image bytes (jpg/png/webp).'),
        caption: z.string().optional().describe('Optional caption.'),
      },
      handler: wrap(
        logger,
        'wa_send_image',
        async ({ to, image_base64, caption }) => {
          const blocked = guard('wa_send_image', to);
          if (blocked) return blocked;

          const buf = decodeBase64(image_base64, 'image_base64');
          const result = await waClient.sendImage(to, buf, { caption });
          return okResponse({ result, bytes: buf.length });
        },
      ),
    },

    // -------------------------------------------------------- 4: wa_send_document
    {
      name: 'wa_send_document',
      description: 'Send a document (PDF, docx, etc.).',
      inputSchema: {
        to: z.string().describe('Phone number in international format or JID'),
        doc_base64: z.string().describe('Base64-encoded document bytes.'),
        filename: z.string().describe('Filename shown to the recipient (e.g. "report.pdf").'),
        mimetype: z.string().describe('MIME type (e.g. "application/pdf").'),
      },
      handler: wrap(
        logger,
        'wa_send_document',
        async ({ to, doc_base64, filename, mimetype }) => {
          const blocked = guard('wa_send_document', to);
          if (blocked) return blocked;

          if (!filename || typeof filename !== 'string') {
            return errorResponse('"filename" must be a non-empty string.');
          }
          if (!mimetype || typeof mimetype !== 'string') {
            return errorResponse('"mimetype" must be a non-empty string.');
          }
          const buf = decodeBase64(doc_base64, 'doc_base64');
          const result = await waClient.sendDocument(to, buf, {
            filename,
            mimetype,
          });
          return okResponse({ result, bytes: buf.length, filename, mimetype });
        },
      ),
    },

    // -------------------------------------------------------- 5: wa_list_chats
    {
      name: 'wa_list_chats',
      description: 'List the most recent WhatsApp chats.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe('Max chats to return (default 50).'),
      },
      handler: wrap(logger, 'wa_list_chats', async ({ limit } = {}) => {
        const lim = Number.isInteger(limit) ? limit : 50;
        const chats = await waClient.listChats({ limit: lim });
        return okResponse({ chats, count: Array.isArray(chats) ? chats.length : undefined });
      }),
    },

    // -------------------------------------------------------- 6: wa_get_messages
    {
      name: 'wa_get_messages',
      description: 'Fetch recent messages for a specific chat (JID).',
      inputSchema: {
        jid: z.string().describe('Chat JID.'),
        limit: z.number().int().min(1).max(500).optional().describe('Max messages to return (default 20).'),
      },
      handler: wrap(logger, 'wa_get_messages', async ({ jid, limit }) => {
        if (!jid || typeof jid !== 'string') {
          return errorResponse('"jid" must be a non-empty string.');
        }
        const lim = Number.isInteger(limit) ? limit : 20;
        const messages = await waClient.getMessages(jid, { limit: lim });
        return okResponse({
          jid,
          messages,
          count: Array.isArray(messages) ? messages.length : undefined,
        });
      }),
    },

    // -------------------------------------------------------- 7: wa_mark_read
    {
      name: 'wa_mark_read',
      description: 'Mark all messages in a chat as read.',
      inputSchema: {
        jid: z.string().describe('Chat JID to mark as read.'),
      },
      handler: wrap(logger, 'wa_mark_read', async ({ jid }) => {
        if (!jid || typeof jid !== 'string') {
          return errorResponse('"jid" must be a non-empty string.');
        }
        const result = await waClient.markRead(jid);
        return okResponse({ jid, result });
      }),
    },

    // -------------------------------------------------------- 8: wa_get_unread
    {
      name: 'wa_get_unread',
      description:
        'Return unread conversations in the last 24h. Each item: { jid, count, preview }.',
      inputSchema: {},
      handler: wrap(logger, 'wa_get_unread', async () => {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const unread = await messageLog.getUnread({ since });
        const items = Array.isArray(unread)
          ? unread.map((u) => ({
              jid: u.jid,
              count: u.count,
              preview:
                u.preview !== undefined
                  ? u.preview
                  : u.lastMessage || u.snippet || null,
            }))
          : unread;
        return okResponse({ since, unread: items });
      }),
    },

    // -------------------------------------------------------- 9: wa_search_messages
    {
      name: 'wa_search_messages',
      description:
        'Full-text search over stored WhatsApp messages. Optionally scoped to a JID.',
      inputSchema: {
        query: z.string().describe('Search query text.'),
        jid: z.string().optional().describe('Optional JID to restrict the search.'),
        limit: z.number().int().min(1).max(500).optional().describe('Max hits to return (default 20).'),
      },
      handler: wrap(
        logger,
        'wa_search_messages',
        async ({ query, jid, limit }) => {
          if (!query || typeof query !== 'string') {
            return errorResponse('"query" must be a non-empty string.');
          }
          const lim = Number.isInteger(limit) ? limit : 20;
          const results = await messageLog.query({ jid, query, limit: lim });
          return okResponse({
            query,
            jid: jid || null,
            results,
            count: Array.isArray(results) ? results.length : undefined,
          });
        },
      ),
    },

    // -------------------------------------------------------- 10: wa_get_recent_activity
    {
      name: 'wa_get_recent_activity',
      description:
        'Return recent activity across all conversations, merged and sorted.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe('Max events to return (default 50).'),
      },
      handler: wrap(
        logger,
        'wa_get_recent_activity',
        async ({ limit } = {}) => {
          const lim = Number.isInteger(limit) ? limit : 50;
          const activity = await messageLog.getRecent({ limit: lim });
          return okResponse({
            activity,
            count: Array.isArray(activity) ? activity.length : undefined,
          });
        },
      ),
    },

    // -------------------------------------------------------- 11: wa_status
    {
      name: 'wa_status',
      description:
        'Return WhatsApp client readiness, owner JID, and process uptime.',
      inputSchema: {},
      handler: wrap(logger, 'wa_status', async () => {
        const ready =
          typeof waClient.isReady === 'function'
            ? Boolean(waClient.isReady())
            : false;
        const uptime_seconds = Math.round((Date.now() - PROCESS_START) / 1000);
        return okResponse({
          ready,
          ownerJid: ownerJid || null,
          uptime_seconds,
        });
      }),
    },
  ];

  return tools;
}
