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

async function postWebhook({ webhookUrl, payload, logger, secret }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const body = JSON.stringify(payload);
    const headers = { 'content-type': 'application/json' };

    // HMAC-SHA256 signature if secret configured
    if (secret) {
      const crypto = await import('node:crypto');
      const sig = crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('hex');
      headers['x-webhook-signature'] = `sha256=${sig}`;
    }

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body,
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

export function attachInboundHandler({ waClient, messageLog, logger, webhookUrl, webhookSecret, ownerJid }) {
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

    // Detect our OWN outgoing messages echoing back through messages.upsert.
    // These cannot be downloaded (Baileys reports "undefined message is not a
    // media message" on freshly-sent outbound audio) and shouldn't trigger a
    // webhook — they'd just create a loop where Leo sees its own reply.
    const isSelfEcho = typeof waClient.isOwnEcho === 'function' && waClient.isOwnEcho(id);
    if (isSelfEcho) {
      logger.info({ id, jid, mediaType }, 'Skipping self-echo (own send)');
      return;
    }

    let mediaPath = null;
    let mediaBuffer = null;
    let mediaMime = null;

    // Download media when:
    //   - AUTO_DOWNLOAD_MEDIA=true   → save to disk + include in webhook (any kind)
    //   - WEBHOOK_INCLUDE_AUDIO=true → inline base64 for voice/audio in webhook
    //   - WEBHOOK_INCLUDE_MEDIA=true → inline base64 for image/document in webhook
    //
    // Defaults:
    //   voice/audio        → inline ON   (Leo needs it to transcribe)
    //   image/document     → inline ON if AUTO_DOWNLOAD_MEDIA=true (Leo cataloga)
    //   video/sticker/other → off by default (too large)
    const isAudio = mediaType === 'voice' || mediaType === 'audio';
    const isCatalogable = mediaType === 'image' || mediaType === 'document';
    const wantInlineAudio = isAudio && process.env.WEBHOOK_INCLUDE_AUDIO !== 'false';
    // Default to true for image/document whenever AUTO_DOWNLOAD_MEDIA is on (opt-out via env)
    const wantInlineMedia = isCatalogable &&
      process.env.AUTO_DOWNLOAD_MEDIA === 'true' &&
      process.env.WEBHOOK_INCLUDE_MEDIA !== 'false';
    const shouldDownload = (
      (process.env.AUTO_DOWNLOAD_MEDIA === 'true' || wantInlineAudio || wantInlineMedia) &&
      mediaType &&
      typeof waClient.downloadMedia === 'function'
    );

    if (shouldDownload) {
      // The event payload from baileys-client.js is { jid, id, ts, fromMe,
      // text, mediaType, message: <rawBaileysMsg> } where rawBaileysMsg has
      // the shape { key, messageTimestamp, pushName, broadcast, message: { audioMessage, ... } }.
      // Baileys' downloadMediaMessage() expects the rawBaileysMsg (one level
      // deeper than what we receive here). Passing the outer wrapper made
      // Object.keys(wrapper.message) return ["key", ...] and Baileys threw
      // `"undefined" message is not a media message`. Fix: pass message.message.
      const baileysMsg = message.message;
      const innerBody = baileysMsg?.message || {};

      const MAX_DOWNLOAD_RETRIES = 3;
      const RETRY_BASE_MS = 1500;
      let downloadOk = false;
      let lastErr = null;

      for (let attempt = 0; attempt < MAX_DOWNLOAD_RETRIES && !downloadOk; attempt++) {
        try {
          if (attempt > 0) {
            const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
            await new Promise((r) => setTimeout(r, delay));
            logger.info(
              { id, jid, mediaType, attempt: attempt + 1, delay },
              'Retrying media download',
            );
          }
          const result = await waClient.downloadMedia(baileysMsg);
          const buffer = Buffer.isBuffer(result) ? result : result?.buffer;
          mediaMime =
            (result && !Buffer.isBuffer(result) && result.mimetype) ||
            innerBody.imageMessage?.mimetype ||
            innerBody.videoMessage?.mimetype ||
            innerBody.audioMessage?.mimetype ||
            innerBody.documentMessage?.mimetype ||
            innerBody.stickerMessage?.mimetype ||
            null;

          if (buffer && buffer.length) {
            mediaBuffer = buffer;
            downloadOk = true;
            if (attempt > 0) {
              logger.info(
                { id, jid, mediaType, attempt: attempt + 1, bytes: buffer.length },
                'Media download succeeded on retry',
              );
            }

            // Persist to disk if AUTO_DOWNLOAD_MEDIA is on
            if (process.env.AUTO_DOWNLOAD_MEDIA === 'true') {
              const authDir = process.env.AUTH_DIR || process.env.WA_AUTH_DIR || './auth';
              const mediaDir = path.resolve(authDir, '..', 'media');
              await mkdir(mediaDir, { recursive: true });
              const ext = extFromMime(mediaMime);
              const safeId = String(id || `msg-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_');
              const filePath = path.join(mediaDir, `${safeId}.${ext}`);
              await writeFile(filePath, buffer);
              mediaPath = filePath;
            }
          } else {
            // Empty buffer — treat as failure to trigger retry
            lastErr = new Error('downloadMedia returned empty buffer');
          }
        } catch (err) {
          lastErr = err;
        }
      }

      if (!downloadOk && lastErr) {
        // Diagnostic dump — read the actual Baileys body (innerBody, two
        // levels deep) so wrapper-detection (audioMessage, ephemeralMessage,
        // viewOnceMessage, etc.) reflects what Baileys would see.
        const bodyKeys = Object.keys(innerBody);
        const bodyStruct = {};
        for (const k of bodyKeys) {
          const v = innerBody[k];
          bodyStruct[k] = v && typeof v === 'object'
            ? `{${Object.keys(v).slice(0,8).join(',')}}`
            : typeof v;
        }
        logger.warn(
          {
            err: lastErr?.message || String(lastErr),
            stack: lastErr?.stack ? String(lastErr.stack).split('\n').slice(0, 4).join(' | ') : null,
            id, jid, mediaType,
            attempts: MAX_DOWNLOAD_RETRIES,
            envelopeKeys: message ? Object.keys(message) : [],
            baileysWrapperKeys: baileysMsg ? Object.keys(baileysMsg) : [],
            bodyKeys,
            bodyStruct,
            hasAudio: !!innerBody.audioMessage,
            hasEphemeral: !!innerBody.ephemeralMessage,
            hasViewOnce: !!innerBody.viewOnceMessage,
            hasViewOnceV2: !!innerBody.viewOnceMessageV2,
            hasDeviceSent: !!innerBody.deviceSentMessage,
          },
          'Failed to download media after retries',
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

        // Inline audio bytes for voice/audio so Leo can transcribe in the
        // same webhook cycle (no second round-trip). Cap at ~8 MB to avoid
        // oversize webhook payloads; WhatsApp voice notes are tiny anyway.
        const MAX_INLINE = 8 * 1024 * 1024;
        if (wantInlineAudio && mediaBuffer && mediaBuffer.length <= MAX_INLINE) {
          payload.audio_base64   = mediaBuffer.toString('base64');
          payload.audio_mimetype = mediaMime || 'audio/ogg';
          payload.audio_bytes    = mediaBuffer.length;
        } else if (wantInlineAudio && mediaBuffer && mediaBuffer.length > MAX_INLINE) {
          logger.warn(
            { bytes: mediaBuffer.length, id },
            'Audio too large to inline in webhook (>8MB), skipping audio_base64',
          );
        }

        // Inline image / document bytes so Leo can catalog + vision-analyze
        // without a second round-trip. Same 8 MB cap. Filename carried through
        // so the catalog can preserve it.
        if (wantInlineMedia && mediaBuffer && mediaBuffer.length <= MAX_INLINE) {
          payload.media_base64   = mediaBuffer.toString('base64');
          payload.media_mimetype = mediaMime || 'application/octet-stream';
          payload.media_bytes    = mediaBuffer.length;
          const docFilename = message?.message?.documentMessage?.fileName
                            || message?.message?.documentMessage?.title
                            || null;
          if (docFilename) payload.media_filename = docFilename;
        } else if (wantInlineMedia && mediaBuffer && mediaBuffer.length > MAX_INLINE) {
          logger.warn(
            { bytes: mediaBuffer.length, id, mediaType },
            'Media too large to inline in webhook (>8MB), skipping media_base64',
          );
        }

        // Fire and forget — don't await.
        postWebhook({ webhookUrl, payload, logger, secret: webhookSecret }).catch((err) => {
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
