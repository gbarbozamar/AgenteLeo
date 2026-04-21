# OpenClaw

[![Deploy on Railway](https://img.shields.io/badge/Deploy%20on-Railway-0B0D0E?logo=railway&logoColor=white)](https://railway.app)

## ¿Qué es OpenClaw?

OpenClaw es un **MCP server** que expone WhatsApp (vía Baileys / WhatsApp Web multi-device) a cualquier cliente compatible con el protocolo MCP — Leo, Claude Desktop, Cursor, n8n, etc. Se auto-deploya en Railway con un volumen persistente para sobrevivir redeploys sin tener que volver a escanear el QR. El objetivo es tener "WhatsApp como herramienta" disponible para agentes de IA de forma segura y reproducible.

## Arquitectura

```
Cliente MCP (Leo, Claude.ai, Cursor, etc)
      │ HTTPS + Bearer token
      ▼
OpenClaw (Railway)
├── Express server
├── MCP Streamable HTTP transport (/mcp)
├── Baileys WhatsApp Web
└── SQLite message log + Baileys auth (volume /data)
      │
      ▼
WhatsApp Web (multi-device, vinculado por QR)
```

## Tools MCP expuestos

| Tool                     | Descripción                                                         |
| ------------------------ | ------------------------------------------------------------------- |
| `wa_send_text`           | Envía un mensaje de texto a un chat o contacto (JID).               |
| `wa_send_voice`          | Envía una nota de voz (audio push-to-talk).                         |
| `wa_send_image`          | Envía una imagen con caption opcional.                              |
| `wa_send_document`       | Envía un archivo adjunto (PDF, docx, etc).                          |
| `wa_list_chats`          | Lista chats recientes con metadatos (unread, lastMessage, pinned).  |
| `wa_get_messages`        | Obtiene mensajes de un chat con paginación por fecha o cantidad.    |
| `wa_mark_read`           | Marca como leído un chat o mensaje específico.                      |
| `wa_get_unread`          | Devuelve la cola de mensajes no leídos agrupados por chat.          |
| `wa_search_messages`     | Búsqueda full-text en el historial local (SQLite FTS).              |
| `wa_get_recent_activity` | Resumen compacto de actividad reciente (útil como contexto de IA).  |
| `wa_status`              | Estado del socket WA (ready, lastConnected, me, version).           |

## Setup local

```bash
# 1. Clonar
git clone https://github.com/<tu-usuario>/openclaw.git
cd openclaw

# 2. Instalar deps
npm install

# 3. Copiar env
cp .env.example .env
# editar .env — setear MCP_BEARER_TOKEN, OWNER_JID

# 4. Arrancar
npm start

# 5. Abrir el QR en el navegador
#    http://localhost:3000/qr
#    Escanear desde WhatsApp → Ajustes → Dispositivos Vinculados
```

Una vez vinculado, la sesión queda guardada en `./data/auth` y no hay que volver a escanear salvo que WhatsApp la invalide.

## Deploy a Railway

Ver [**DEPLOY-RAILWAY.md**](./DEPLOY-RAILWAY.md) para la guía paso a paso (crear repo, variables, volumen, vinculado de WA, troubleshooting).

## Seguridad

- **`WA_ALLOW_ANY=false`** por default — sólo el `OWNER_JID` puede enviar comandos reflejados; los tools rechazan destinatarios fuera de la whitelist si el guardarraíl está activo.
- **Bearer token obligatorio** en producción (`MCP_BEARER_TOKEN`). Toda request a `/mcp` y `/qr` se valida contra este token.
- **Rate limiting** por IP y por tool (evita loops de agente o abuso).
- Logs estructurados con nivel configurable (`LOG_LEVEL`). Nunca se loguea el contenido completo de mensajes a nivel `info`.
- El volumen `/data` contiene material sensible (claves Baileys + historial) — Railway lo mantiene privado al proyecto.

## Conectar Leo (o cualquier cliente MCP)

En la configuración MCP del cliente:

```json
{
  "mcpServers": {
    "openclaw": {
      "type": "http",
      "url": "https://<tu-app>.railway.app/mcp",
      "headers": { "Authorization": "Bearer <tu-token>" }
    }
  }
}
```

En Leo alcanza con setear en `.env`:

```
OPENCLAW_MCP_URL=https://<tu-app>.railway.app/mcp
OPENCLAW_MCP_TOKEN=<tu-token>
```

## Uso programático

Normalmente no se llama directo (el cliente MCP abstrae la negociación), pero como referencia:

```bash
curl -X POST https://<tu-app>.railway.app/mcp \
  -H "Authorization: Bearer <tu-token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "wa_status",
      "arguments": {}
    }
  }'
```

## Troubleshooting

| Síntoma                                    | Causa probable / fix                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| El QR no aparece en `/qr`                  | El socket todavía no inicializó; esperar 5–10s y refrescar. Verificar logs (`LOG_LEVEL=debug`).                   |
| WhatsApp se desvincula solo                | Casi siempre es el volumen Railway no montado — los archivos de `/data/auth` se pierden en cada redeploy.         |
| Token 401 al hacer `/mcp`                  | `MCP_BEARER_TOKEN` no configurado o el cliente manda mal el header `Authorization: Bearer ...`.                   |
| `Rate limit exceeded`                      | Bajar frecuencia de llamadas o ajustar `RATE_LIMIT_*` en `.env`. Por default es generoso pero no ilimitado.       |
| Mensajes enviados no llegan                | Chequear `wa_status` → `ready: true`. Si `ready: false`, el socket está reconectando.                             |
| "Destinatario fuera de whitelist"          | `WA_ALLOW_ANY=false` y el JID destino no es el `OWNER_JID`. Para destinatarios libres, setear `WA_ALLOW_ANY=true` (con cuidado). |
| Build falla en Railway                     | Verificar que el Dockerfile esté en la raíz y que `railway.json` apunte a él.                                     |
| Se llena el volumen                        | La DB `messages.db` crece con el historial. Hacer pruning periódico o subir el tamaño del volumen.                |
