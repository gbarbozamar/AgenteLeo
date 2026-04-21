import 'dotenv/config';
import express from 'express';
import pino from 'pino';

import { WhatsAppClient }        from './whatsapp/baileys-client.js';
import { attachInboundHandler }  from './whatsapp/inbound-handler.js';
import { startMcpServer }        from './mcp/server.js';
import { buildTools }            from './mcp/tools.js';
import { createAuthStateLoader } from './storage/auth-state.js';
import { MessageLog }            from './storage/message-log.js';
import { createQrRouter }        from './web/qr-endpoint.js';
import {
  createBearerMiddleware,
  createRateLimiter,
  generateToken,
} from './security/auth.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

async function main() {
  const {
    PORT = '3000',
    MCP_BEARER_TOKEN,
    AUTH_DIR = './auth_info',
    DB_PATH = './data/messages.db',
    OWNER_JID,
    INBOUND_WEBHOOK_URL = '',
    RATE_LIMIT_WINDOW_MS = '60000',
    RATE_LIMIT_MAX = '60',
  } = process.env;

  // Validation
  if (!MCP_BEARER_TOKEN) {
    const fresh = generateToken(32);
    logger.warn(
      { sampleToken: fresh },
      '⚠️  MCP_BEARER_TOKEN not set — running UNPROTECTED. Example token to set:',
    );
  }
  if (!OWNER_JID) {
    logger.warn('⚠️  OWNER_JID not set — tools will reject all sends until you set it');
  }

  // Storage
  const messageLog = new MessageLog({ dbPath: DB_PATH, logger });
  await messageLog.init();
  const authStateLoader = await createAuthStateLoader({ authDir: AUTH_DIR, logger });

  // WhatsApp
  const waClient = new WhatsAppClient({
    authStateLoader,
    authStateSaver: null, // auth-state handles its own persistence
    logger,
  });

  // Start Baileys (async — emits 'qr' then 'ready')
  waClient.start().catch((err) => logger.error({ err }, 'Baileys start failed'));

  // Inbound handler: logs messages + optional webhook
  attachInboundHandler({
    waClient,
    messageLog,
    logger,
    webhookUrl: INBOUND_WEBHOOK_URL || null,
    ownerJid: OWNER_JID,
  });

  // Express app
  const app = express();
  app.use(express.json({ limit: '10mb' })); // MCP requests can carry base64 media

  // Rate limiter
  const rateLimiter = createRateLimiter({
    windowMs: parseInt(RATE_LIMIT_WINDOW_MS),
    max: parseInt(RATE_LIMIT_MAX),
    logger,
  });
  app.use(rateLimiter);

  // Health (public — mounted BEFORE auth-protected routers so Railway's probe works)
  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: 'openclaw',
      ready: waClient.isReady(),
      uptimeSec: Math.floor(process.uptime()),
    });
  });

  // QR endpoint (token-protected if MCP_BEARER_TOKEN set)
  app.use(
    '/',
    createQrRouter({
      waClient,
      logger,
      bearerToken: MCP_BEARER_TOKEN || null,
    }),
  );

  // MCP server — mounts POST/GET/DELETE /mcp
  const tools = buildTools({ waClient, messageLog, logger, ownerJid: OWNER_JID });
  await startMcpServer({
    app,
    path: '/mcp',
    tools,
    authToken: MCP_BEARER_TOKEN || null,
    logger,
  });

  // Start HTTP
  const server = app.listen(parseInt(PORT), () => {
    logger.info({ port: PORT }, '🚀 OpenClaw listening');
    logger.info('Endpoints:');
    logger.info('  GET  /qr      → pair WhatsApp');
    logger.info('  POST /mcp     → MCP requests (bearer required)');
    logger.info('  GET  /health  → health check');
  });

  // Graceful shutdown
  const shutdown = async (sig) => {
    logger.info({ sig }, 'Shutting down');
    server.close();
    try { await waClient.stop(); } catch {}
    try { messageLog.close(); } catch {}
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal boot error');
  process.exit(1);
});
