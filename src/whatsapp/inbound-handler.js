import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

function normalizeJid(x) {
  if (!x) return '';
  return String(x).replace(/\D+/g, '') + (x.includes('@') ? '' : '@s.whatsapp.net');
}

function extFromMime(mime) {
  if (!mime) return 'bin';
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'video/quicktime': 'mov',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt',
  };
  if (map[mime]) return map[mime];
  const slash = mime.indexOf('/');
  if (slash >= 0) {
    const sub = mime.slice(slash + 1).split(';')[0].trim();
    if (sub) return sub;
  }
  return 'bin';
}

async function postWebhook({ webhookUrl, payload, logger }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn({ status: res.status, url: webhookUrl }, 'Webhook non-2xx response');
    }
  } catch (err) {
    logger.warn({ err: err?.message || String(err), url: webhookUrl }, 'Webhook delivery failed');
  } finally {
    clearTimeout(timeout);
  }
}

export function attachInboundHandler({ waClient, messageLog, logger, webhookUrl, ownerJid }) {
  if (!waClient || typeof waClient.on !== 'function') {
    throw new Error('attachInboundHandler: waClient with .on() required');
  }
  if (!messageLog || typeof messageLog.append !== 'function') {
    throw new Error('attachInboundHandler: messageLog.append required');
  }
  if (!logger || typeof logger.info !== 'function') {
    throw new Error('attachInboundHandler: logger required');
  }

  const RATE_WINDOW_MS = 10_000;
  const RATE_LIMIT = 20;
  const webhookTimestamps = [];
  let rateLimitWarned = false;

  const handler = async (message) => {
    if (!message || typeof message !== 'object') return;

    const {
      jid,
      fromMe,
      id,
      ts,
      text = '',
      mediaType = null,
    } = message;

    try {
      await messageLog.append({
        id,
        jid,
        fromMe,
        ts,
        text: text || '',
        mediaType: mediaType || null,
      });
    } catch (err) {
      logger.warn(
        { err: err?.message || String(err), id, jid },
        'Failed to persist inbound WA message',
      );
    }

    const safeText = typeof text === 'string' ? text : '';
    logger.info(
      { jid, fromMe, textPreview: safeText.slice(0, 50) },
      'Inbound WA',
    );

    let mediaPath = null;
    if (
      process.env.AUTO_DOWNLOAD_MEDIA === 'true' &&
      mediaType &&
      typeof waClient.downloadMedia === 'function'
    ) {
      try {
        const buffer = await waClient.downloadMedia(message);
        if (buffer && buffer.length) {
          const authDir = process.env.AUTH_DIR || process.env.WA_AUTH_DIR || './auth';
          const mediaDir = path.resolve(authDir, '..', 'media');
          await mkdir(mediaDir, { recursive: true });
          const mime =
            message?.message?.imageMessage?.mimetype ||
            message?.message?.videoMessage?.mimetype ||
            message?.message?.audioMessage?.mimetype ||
            message?.message?.documentMessage?.mimetype ||
            message?.message?.stickerMessage?.mimetype ||
            null;
          const ext = extFromMime(mime);
          const safeId = String(id || `msg-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = path.join(mediaDir, `${safeId}.${ext}`);
          await writeFile(filePath, buffer);
          mediaPath = filePath;
        }
      } catch (err) {
        logger.warn(
          { err: err?.message || String(err), id, jid, mediaType },
          'Failed to auto-download media',
        );
      }
    }

    if (webhookUrl) {
      const now = Date.now();
      while (webhookTimestamps.length && now - webhookTimestamps[0] > RATE_WINDOW_MS) {
        webhookTimestamps.shift();
      }

      if (webhookTimestamps.length >= RATE_LIMIT) {
        if (!rateLimitWarned) {
          logger.warn(
            { windowMs: RATE_WINDOW_MS, limit: RATE_LIMIT },
            'Webhook rate limit exceeded; dropping deliveries',
          );
          rateLimitWarned = true;
        }
      } else {
        webhookTimestamps.push(now);
        rateLimitWarned = false;

        const payload = {
          event: 'whatsapp.message',
          ts,
          jid,
          from_me: fromMe,
          id,
          text: safeText,
          media_type: mediaType || null,
          is_owner: normalizeJid(jid) === normalizeJid(ownerJid),
        };
        if (mediaPath) payload.media_path = mediaPath;

        // Fire and forget — don't await.
        postWebhook({ webhookUrl, payload, logger }).catch((err) => {
          logger.warn(
            { err: err?.message || String(err) },
            'Unexpected webhook dispatch error',
          );
        });
      }
    }
  };

  waClient.on('message', handler);

  return () => {
    if (typeof waClient.off === 'function') {
      waClient.off('message', handler);
    } else if (typeof waClient.removeListener === 'function') {
      waClient.removeListener('message', handler);
    }
  };
}
