/**
 * OpenClaw MCP Server (Streamable HTTP transport, spec 2025-06-18).
 *
 * Mounts MCP endpoints on a caller-provided Express app and exposes the
 * supplied tools over the Streamable HTTP transport defined by the MCP spec
 * at https://modelcontextprotocol.io/specification/2025-06-18/basic/transports.
 *
 * The caller owns the Express app and the HTTP listener. This module only:
 *   1. Instantiates `McpServer` and registers tools.
 *   2. Instantiates `StreamableHTTPServerTransport` and connects it.
 *   3. Mounts POST/GET/DELETE handlers at `path` with an inline bearer guard.
 *
 * No side effects at import time.
 */

import crypto from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Build a minimal bearer-token middleware. If `expected` is falsy the
 * middleware is a no-op — useful for local dev where no token is set.
 *
 * A more robust implementation lives in `src/security/auth.js`; this inline
 * version keeps this module standalone.
 *
 * @param {string | undefined | null} expected
 * @returns {import('express').RequestHandler}
 */
function bearerMiddleware(expected) {
  return (req, res, next) => {
    if (!expected) return next();
    const hdr = req.headers.authorization || '';
    if (hdr === `Bearer ${expected}`) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  };
}

/**
 * Build a no-op logger that satisfies the pino-style interface used by this
 * module. Used as a fallback when the caller does not pass a logger.
 */
function noopLogger() {
  const fn = () => {};
  return { info: fn, warn: fn, error: fn, debug: fn, trace: fn };
}

/**
 * @typedef {Object} McpTool
 * @property {string} name          Unique tool name.
 * @property {string} description   Human-readable description.
 * @property {object} inputSchema   JSON-schema-like object describing args.
 * @property {(args: any) => Promise<{ content: Array<{ type: string, text: string }> }>} handler
 */

/**
 * @typedef {Object} StartMcpServerOptions
 * @property {import('express').Express} app        Express app to mount on.
 * @property {string} [path]                         Endpoint path (default: `/mcp`).
 * @property {McpTool[]} tools                       Tools to register.
 * @property {string} [authToken]                    Bearer token (optional).
 * @property {any}    [logger]                       pino-style logger (optional).
 */

/**
 * Start the MCP server on top of the caller's Express app.
 *
 * @param {StartMcpServerOptions} opts
 * @returns {Promise<{ server: McpServer, transport: StreamableHTTPServerTransport }>}
 */
export async function startMcpServer({
  app,
  path = '/mcp',
  tools,
  authToken,
  logger,
}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('startMcpServer: `app` must be an Express app instance');
  }
  if (!Array.isArray(tools)) {
    throw new TypeError('startMcpServer: `tools` must be an array');
  }

  const log = logger || noopLogger();

  // 1. Create the MCP server.
  const server = new McpServer({ name: 'openclaw', version: '0.1.0' });

  // 2. Register tools. Wrap each handler so we can log call + result and
  //    surface errors as structured MCP tool results rather than exceptions.
  for (const t of tools) {
    if (!t || !t.name || typeof t.handler !== 'function') {
      log.warn({ tool: t && t.name }, 'MCP tool skipped (invalid shape)');
      continue;
    }

    const wrapped = async (args) => {
      const started = Date.now();
      log.info({ tool: t.name }, 'MCP tool call');
      try {
        const result = await t.handler(args);
        log.info(
          { tool: t.name, ms: Date.now() - started },
          'MCP tool ok',
        );
        return result;
      } catch (err) {
        log.error(
          { tool: t.name, err: err && err.message, ms: Date.now() - started },
          'MCP tool failed',
        );
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: (err && err.message) || 'Tool execution failed',
              }),
            },
          ],
        };
      }
    };

    server.tool(t.name, t.description, t.inputSchema, wrapped);
  }

  // 3. Stateless mode — each request gets a fresh transport so multiple
  //    clients (Leo, claude.ai, cursor, etc.) can connect concurrently
  //    without session conflicts. Setting sessionIdGenerator: undefined
  //    tells the SDK to run in stateless mode per MCP spec 2025-06-18.
  //
  //    Trade-off: no server-initiated messages (we don't need them).
  const guard = bearerMiddleware(authToken);

  async function handlePost(req, res) {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      res.on('close', () => {
        try { transport.close(); } catch {}
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error({ err: err && err.message }, 'MCP POST handler failed');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal MCP error' });
      }
    }
  }

  app.post(path, guard, handlePost);

  // In stateless mode, GET/DELETE on /mcp are not supported (no session to resume)
  app.get(path, guard, (req, res) =>
    res.status(405).json({ error: 'Method not allowed in stateless mode' }),
  );

  app.delete(path, guard, async (req, res) => {
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      log.error({ err: err && err.message }, 'MCP DELETE handler failed');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal MCP error' });
      }
    }
  });

  log.info(
    { path, tools: tools.length, auth: Boolean(authToken) },
    'MCP server mounted',
  );

  return { server };
}

export default startMcpServer;
