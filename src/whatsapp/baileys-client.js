// src/whatsapp/baileys-client.js
//
// OpenClaw — WhatsApp client wrapper sobre Baileys.
// Expone una API limpia basada en EventEmitter para auth multi-device,
// envío de mensajes (texto/voz/imagen/documento), listado de chats,
// historial y descarga de media.
//
// Docs: https://baileys.whiskeysockets.io
//       https://github.com/WhiskeySockets/Baileys

import { EventEmitter } from 'node:events';
import makeWASocket, {
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';

const MIN_RECONNECT_MS = 3_000;
const MAX_RECONNECT_MS = 30_000;

/**
 * Normaliza un JID de WhatsApp.
 * Acepta: "+5491112345678", "5491112345678", "5491112345678@s.whatsapp.net",
 *         o JIDs de grupo "xxxxx@g.us".
 */
export function normalizeJid(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('normalizeJid: input inválido (se esperaba string)');
  }
  let jid = input.trim();

  // Si ya es un JID (contiene @), lo devolvemos tal cual.
  if (jid.includes('@')) return jid;

  // Limpiar "+" iniciales, espacios, guiones y paréntesis.
  jid = jid.replace(/[\s()\-+]/g, '');

  if (!/^\d+$/.test(jid)) {
    throw new Error(`normalizeJid: número inválido "${input}"`);
  }

  return `${jid}@s.whatsapp.net`;
}

/**
 * Extrae texto plano de un mensaje Baileys (si existe).
 */
function extractText(message) {
  if (!message) return '';
  const m = message.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  );
}

/**
 * Detecta el tipo de media de un mensaje Baileys (si aplica).
 */
function detectMediaType(message) {
  if (!message) return undefined;
  const m = message.message || {};
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return m.audioMessage.ptt ? 'voice' : 'audio';
  if (m.documentMessage) return 'document';
  if (m.stickerMessage) return 'sticker';
  return undefined;
}

/**
 * Obtiene el mimetype del contenido multimedia del mensaje (si existe).
 */
function detectMimetype(message) {
  if (!message) return undefined;
  const m = message.message || {};
  return (
    m.imageMessage?.mimetype ||
    m.videoMessage?.mimetype ||
    m.audioMessage?.mimetype ||
    m.documentMessage?.mimetype ||
    m.stickerMessage?.mimetype ||
    undefined
  );
}

export class WhatsAppClient extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {Function} opts.authStateLoader async () => ({ state, saveCreds })
   * @param {Function} [opts.authStateSaver] opcional, hook extra de persistencia
   * @param {import('pino').Logger} opts.logger pino logger
   */
  constructor({ authStateLoader, authStateSaver, logger } = {}) {
    super();

    if (typeof authStateLoader !== 'function') {
      throw new Error('WhatsAppClient: authStateLoader es requerido y debe ser una función');
    }
    if (!logger) {
      throw new Error('WhatsAppClient: logger (pino) es requerido');
    }

    this.authStateLoader = authStateLoader;
    this.authStateSaver = authStateSaver || null;
    this.logger = logger;

    this.sock = null;
    this._ready = false;
    this._stopping = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;

    // Caché ligero de chats y mensajes recientes alimentado por eventos.
    this._chats = new Map();       // jid -> { jid, name, unreadCount, lastMessage }
    this._messages = new Map();    // jid -> [{ id, ts, fromMe, text, mediaType, raw }]
    this._sentIds = new Map();     // messageId -> expiresAtMs (ids we produced via send*)
  }

  isReady() {
    return this._ready === true;
  }

  /**
   * Arranca la conexión con WhatsApp.
   */
  async start() {
    this._stopping = false;
    await this._connect();
  }

  /**
   * Cierra la conexión de forma limpia (sin logout).
   */
  async stop() {
    this._stopping = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        await this.sock.end(undefined);
      } catch (err) {
        this.logger.warn({ err }, 'Error cerrando socket Baileys');
      }
      this.sock = null;
    }
    this._ready = false;
  }

  // --- INTERNO ---------------------------------------------------------

  async _connect() {
    const { state, saveCreds } = await this.authStateLoader();
    const { version, isLatest } = await fetchLatestBaileysVersion();
    this.logger.info({ version, isLatest }, 'Iniciando socket Baileys');

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: this.logger,
      browser: ['OpenClaw', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    this.sock = sock;

    // Persistencia de credenciales.
    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        if (this.authStateSaver) await this.authStateSaver();
      } catch (err) {
        this.logger.error({ err }, 'Error guardando credenciales');
        this.emit('error', err);
      }
    });

    // Estado de conexión: QR, ready, disconnected.
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.logger.info('QR recibido — emitiendo evento');
        this.emit('qr', qr);
      }

      if (connection === 'open') {
        this._ready = true;
        this._reconnectAttempts = 0;
        this.logger.info('Conexión WhatsApp abierta');
        this.emit('ready');
      }

      if (connection === 'close') {
        this._ready = false;
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.output?.payload?.statusCode;

        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const canReconnect = !loggedOut && !this._stopping;

        this.logger.warn(
          { statusCode, loggedOut, canReconnect, err: lastDisconnect?.error },
          'Conexión cerrada',
        );

        this.emit('disconnected', {
          reason: statusCode,
          canReconnect,
        });

        if (canReconnect) {
          this._scheduleReconnect();
        }
      }
    });

    // Mensajes entrantes/emitidos.
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (!messages || !messages.length) return;
      for (const msg of messages) {
        try {
          this._handleIncomingMessage(msg, type);
        } catch (err) {
          this.logger.error({ err }, 'Error procesando messages.upsert');
          this.emit('error', err);
        }
      }
    });

    // Actualizaciones de chats (nombres, unreadCount).
    sock.ev.on('chats.upsert', (chats) => {
      for (const chat of chats) this._upsertChat(chat);
    });
    sock.ev.on('chats.update', (chats) => {
      for (const chat of chats) this._upsertChat(chat);
    });

    // Errores genéricos del socket.
    sock.ev.on('CB:stream:error', (err) => {
      this.logger.error({ err }, 'CB:stream:error');
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectAttempts += 1;

    const delay = Math.min(
      MIN_RECONNECT_MS * Math.pow(2, this._reconnectAttempts - 1),
      MAX_RECONNECT_MS,
    );

    this.logger.info(
      { attempt: this._reconnectAttempts, delay },
      'Reintentando conexión WhatsApp',
    );

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this._connect();
      } catch (err) {
        this.logger.error({ err }, 'Error reconectando');
        this.emit('error', err);
        if (!this._stopping) this._scheduleReconnect();
      }
    }, delay);
  }

  _handleIncomingMessage(msg, _type) {
    if (!msg || !msg.key) return;

    const jid = msg.key.remoteJid;
    const id = msg.key.id;
    const fromMe = !!msg.key.fromMe;
    const tsRaw = msg.messageTimestamp;
    const ts =
      typeof tsRaw === 'number'
        ? tsRaw * 1000
        : tsRaw && typeof tsRaw.toNumber === 'function'
          ? tsRaw.toNumber() * 1000
          : Date.now();

    const text = extractText(msg);
    const mediaType = detectMediaType(msg);

    const entry = { id, ts, fromMe, text, mediaType, raw: msg };
    const list = this._messages.get(jid) || [];
    list.push(entry);
    if (list.length > 500) list.splice(0, list.length - 500);
    this._messages.set(jid, list);

    // Actualizar lastMessage del chat.
    const existing = this._chats.get(jid) || { jid, name: undefined, unreadCount: 0 };
    existing.lastMessage = { id, ts, fromMe, text, mediaType };
    if (!fromMe) existing.unreadCount = (existing.unreadCount || 0) + 1;
    this._chats.set(jid, existing);

    this.emit('message', {
      jid,
      id,
      ts,
      fromMe,
      text,
      mediaType,
      message: msg,
    });
  }

  _upsertChat(chat) {
    if (!chat || !chat.id) return;
    const jid = chat.id;
    const prev = this._chats.get(jid) || { jid };
    const merged = {
      ...prev,
      jid,
      name: chat.name ?? chat.subject ?? prev.name,
      unreadCount:
        typeof chat.unreadCount === 'number' ? chat.unreadCount : prev.unreadCount || 0,
      lastMessage: prev.lastMessage,
    };
    this._chats.set(jid, merged);
  }

  _assertReady() {
    if (!this._ready || !this.sock) {
      throw new Error('WhatsAppClient no está listo (todavía no hay conexión abierta)');
    }
  }

  // --- API PÚBLICA -----------------------------------------------------

  /**
   * Remember a just-sent messageId so the messages.upsert event for this
   * same id is recognized as our own echo (prevents self-download and
   * self-webhook loops).
   */
  _rememberSent(id) {
    if (!id || !this._sentIds) return;
    this._sentIds.set(String(id), Date.now() + 3 * 60 * 1000); // 3 min TTL
    // Periodic cleanup
    if (this._sentIds.size > 2000) {
      const now = Date.now();
      for (const [k, v] of this._sentIds) if (v <= now) this._sentIds.delete(k);
    }
  }

  /** True when this id was produced by one of our own send* calls. */
  isOwnEcho(id) {
    if (!id || !this._sentIds) return false;
    const exp = this._sentIds.get(String(id));
    if (!exp) return false;
    if (exp <= Date.now()) {
      this._sentIds.delete(String(id));
      return false;
    }
    return true;
  }

  async sendText(jid, text) {
    this._assertReady();
    const to = normalizeJid(jid);
    const res = await this.sock.sendMessage(to, { text: String(text ?? '') });
    this._rememberSent(res?.key?.id);
    return { messageId: res?.key?.id };
  }

  async sendVoice(jid, oggOpusBuffer) {
    this._assertReady();
    if (!Buffer.isBuffer(oggOpusBuffer)) {
      throw new Error('sendVoice: oggOpusBuffer debe ser un Buffer');
    }
    const to = normalizeJid(jid);
    const res = await this.sock.sendMessage(to, {
      audio: oggOpusBuffer,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true,
    });
    this._rememberSent(res?.key?.id);
    return { messageId: res?.key?.id };
  }

  async sendImage(jid, imageBuffer, caption = '') {
    this._assertReady();
    if (!Buffer.isBuffer(imageBuffer)) {
      throw new Error('sendImage: imageBuffer debe ser un Buffer');
    }
    const to = normalizeJid(jid);
    const res = await this.sock.sendMessage(to, {
      image: imageBuffer,
      caption: String(caption ?? ''),
    });
    this._rememberSent(res?.key?.id);
    return { messageId: res?.key?.id };
  }

  async sendDocument(jid, buffer, filename, mimetype) {
    this._assertReady();
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('sendDocument: buffer debe ser un Buffer');
    }
    if (!filename) throw new Error('sendDocument: filename es requerido');
    if (!mimetype) throw new Error('sendDocument: mimetype es requerido');

    const to = normalizeJid(jid);
    const res = await this.sock.sendMessage(to, {
      document: buffer,
      fileName: filename,
      mimetype,
    });
    this._rememberSent(res?.key?.id);
    return { messageId: res?.key?.id };
  }

  /**
   * Lista los chats conocidos (desde el caché alimentado por eventos).
   * Ordenados por timestamp del último mensaje (descendente).
   */
  async listChats({ limit = 50 } = {}) {
    const all = Array.from(this._chats.values());
    all.sort((a, b) => {
      const ta = a.lastMessage?.ts || 0;
      const tb = b.lastMessage?.ts || 0;
      return tb - ta;
    });
    return all.slice(0, limit).map((c) => ({
      jid: c.jid,
      name: c.name,
      unreadCount: c.unreadCount || 0,
      lastMessage: c.lastMessage
        ? {
            id: c.lastMessage.id,
            ts: c.lastMessage.ts,
            fromMe: c.lastMessage.fromMe,
            text: c.lastMessage.text,
            mediaType: c.lastMessage.mediaType,
          }
        : null,
    }));
  }

  /**
   * Devuelve los últimos mensajes observados para un JID.
   * Nota: Baileys no expone un history fetch genérico estable entre versiones;
   * esta implementación se apoya en el caché en memoria alimentado por
   * `messages.upsert`. Si se requiere historial persistente, la capa de
   * almacenamiento debe conectarse por encima.
   */
  async getMessages(jid, { limit = 20 } = {}) {
    const key = normalizeJid(jid);
    const list = this._messages.get(key) || [];
    return list
      .slice(-limit)
      .map((m) => ({
        id: m.id,
        ts: m.ts,
        fromMe: m.fromMe,
        text: m.text,
        mediaType: m.mediaType,
      }));
  }

  async markRead(jid) {
    this._assertReady();
    const to = normalizeJid(jid);
    const list = this._messages.get(to) || [];
    const unread = list.filter((m) => !m.fromMe).slice(-20);

    if (unread.length) {
      const keys = unread.map((m) => ({
        remoteJid: to,
        id: m.id,
        fromMe: false,
      }));
      try {
        await this.sock.readMessages(keys);
      } catch (err) {
        this.logger.warn({ err, jid: to }, 'readMessages falló');
      }
    }

    const chat = this._chats.get(to);
    if (chat) {
      chat.unreadCount = 0;
      this._chats.set(to, chat);
    }
    return { ok: true };
  }

  /**
   * Descarga el contenido multimedia de un mensaje Baileys.
   * @param {object} message mensaje Baileys completo (el que llega por el evento 'message')
   * @returns {Promise<{ buffer: Buffer, mimetype: string|undefined }>}
   */
  async downloadMedia(message) {
    this._assertReady();
    if (!message || !message.message) {
      throw new Error('downloadMedia: mensaje Baileys inválido');
    }

    if (!this.sock.updateMediaMessage) {
      this.logger.warn({ id: message?.key?.id }, 'downloadMedia: sock.updateMediaMessage is not available — reupload will fail');
    }

    const buffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        logger: this.logger,
        reuploadRequest: this.sock.updateMediaMessage,
      },
    );

    return {
      buffer,
      mimetype: detectMimetype(message),
    };
  }
}

export default WhatsAppClient;
