# Deploy de OpenClaw a Railway

Guía paso a paso para publicar OpenClaw como MCP server en Railway, con volumen persistente para la sesión de WhatsApp.

---

## 1. Crear repo Git local

```bash
cd "C:/Users/barbo/Documents/PhD/AI Deep Economics/OpenClaw"
git init
git add .
git commit -m "Initial OpenClaw scaffold"
```

---

## 2. Crear repo en GitHub

Crear el repo remoto manualmente en [https://github.com/new](https://github.com/new). Nombre sugerido: **`openclaw`** (privado recomendado porque vas a vincular tu WhatsApp personal).

Luego, desde la carpeta local:

```bash
git remote add origin https://github.com/<tu-usuario>/openclaw.git
git branch -M main
git push -u origin main
```

---

## 3. Crear proyecto en Railway

1. Ir a [https://railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
2. Autorizar Railway a leer tu cuenta de GitHub si todavía no lo hiciste.
3. Seleccionar el repo `openclaw`.
4. Railway detecta el `Dockerfile` y empieza el primer build automáticamente.

El primer build va a fallar o quedar en loop hasta que agregues las variables de entorno del paso 4. Eso es esperable.

---

## 4. Configurar variables de entorno

En Railway → tu servicio → **Settings** → **Variables**, agregar:

| Variable              | Valor                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `MCP_BEARER_TOKEN`    | Generarlo localmente con `node src/security/auth.js` y pegar el output (es un hex de 64 chars).          |
| `OWNER_JID`           | Tu número en formato internacional sin `+` ni espacios, p.ej. `5491112345678`.                           |
| `LOG_LEVEL`           | `info` para producción (`debug` sólo si estás diagnosticando).                                           |
| `WA_ALLOW_ANY`        | `false` (default seguro — sólo responder/enviar al owner).                                               |
| `INBOUND_WEBHOOK_URL` | Opcional. URL de Leo o n8n si querés que OpenClaw empuje eventos entrantes de WA (mensaje nuevo, etc.). |

Guardar. Railway redeploya automáticamente con las nuevas variables.

---

## 5. Agregar volumen persistente (CRÍTICO)

Sin esto, cada redeploy pierde la sesión de WhatsApp y hay que volver a escanear el QR. Además se pierde el historial local.

1. Railway → tu servicio → **Settings** → **Volumes** → **Add Volume**.
2. **Mount path**: `/data`
3. **Size**: `1 GB` (suficiente para la auth + varios meses de historial; se puede subir después).
4. Guardar. Railway redeploya con el volumen montado.

Las variables `AUTH_DIR=/data/auth` y `DB_PATH=/data/messages.db` ya vienen configuradas en el `Dockerfile`, así que no hay que setearlas a mano.

---

## 6. Exponer el dominio público

1. **Settings** → **Networking** → **Generate Domain**.
2. Guardar la URL que te da Railway: `https://<algo>.up.railway.app`.

Esa URL es la que va a usar el cliente MCP (Leo, Claude Desktop, etc).

---

## 7. Vincular WhatsApp (primera vez)

1. Abrir en el navegador: `https://<tu-app>.up.railway.app/qr?token=<tu-MCP_BEARER_TOKEN>`.
2. En tu celular: **WhatsApp** → **Ajustes** → **Dispositivos Vinculados** → **Vincular un dispositivo**.
3. Escanear el QR que aparece en la pantalla.
4. Esperar el mensaje **"Paired"** en la UI (unos segundos). A partir de ese punto, la sesión queda guardada en `/data/auth` y no tenés que volver a escanear salvo que desvincules manualmente.

---

## 8. Verificar

```bash
curl https://<tu-app>.up.railway.app/health
# esperado: { "ok": true, "ready": true }
```

Si `ready: false`, Baileys todavía está estableciendo la conexión — esperar unos segundos y reintentar.

Configurar en el cliente (ejemplo Leo — `.env`):

```
OPENCLAW_MCP_URL=https://<tu-app>.up.railway.app/mcp
OPENCLAW_MCP_TOKEN=<tu-MCP_BEARER_TOKEN>
```

Reiniciar Leo. En el primer handshake MCP deberías ver los `wa_*` tools listados.

---

## 9. Troubleshooting

| Error                                                  | Causa probable / fix                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Build falla con `Cannot find Dockerfile`               | El `Dockerfile` no está en la raíz del repo o hay `.dockerignore` demasiado agresivo.                                                 |
| Deploy sube pero `/qr` da 401                          | Te falta pasar `?token=<MCP_BEARER_TOKEN>` en el query, o el token no coincide con la variable.                                      |
| QR se genera pero al escanear "No se pudo vincular"    | Problema de reloj del contenedor (raro) o versión de WA. Redeploy. Si persiste, borrar `/data/auth` y reintentar.                    |
| Después de un redeploy pide QR de nuevo                | El **volumen** no está montado en `/data` o se cambió el `AUTH_DIR`. Volver al paso 5.                                               |
| `/health` devuelve `ready: false` permanentemente      | Baileys no pudo conectar. Revisar logs — típicamente es auth corrupta. Borrar `/data/auth` desde la CLI de Railway y re-escanear.    |
| Leo dice `fetch failed` al `OPENCLAW_MCP_URL`          | El dominio Railway no fue generado (paso 6) o la URL tiene typo. Probar `curl /health` primero.                                      |
| 401 desde Leo pero 200 desde curl                      | `OPENCLAW_MCP_TOKEN` mal pegado en `.env` de Leo (espacios, newline). Regenerar y volver a copiar.                                   |
| "disk full" o errores sqlite                           | El volumen de 1 GB se llenó. Subir tamaño en Railway → Volumes, o hacer pruning de `messages.db`.                                    |
| Mensajes enviados tardan mucho o fallan                | Rate limiting de WhatsApp (demasiados envíos en poco tiempo). Bajar frecuencia, respetar ventanas.                                   |

---

## 10. Upgrade / redeploy

El flujo es git-driven:

```bash
git add .
git commit -m "fix: <descripción>"
git push
```

Railway detecta el push a `main`, buildea la nueva imagen y la publica con zero-downtime (o casi). **La sesión de WhatsApp se preserva** porque `/data` está en el volumen, no en el filesystem efímero del contenedor.

Si necesitás **forzar un redeploy limpio** (p.ej. después de cambiar variables sensibles), usá **Deployments** → **Redeploy** en la UI de Railway.

Para **invalidar la sesión** (cambio de cuenta, compromiso de credenciales):

1. Abrir la CLI de Railway o la shell del servicio.
2. `rm -rf /data/auth`
3. Redeploy → volver al paso 7 y escanear QR de nuevo.

---

## Coste estimado en Railway

**~$1–3 USD/mes** con el tier Hobby. Los **$5 de crédito gratuito mensual** de Railway suelen ser más que suficientes para OpenClaw corriendo 24/7: el servicio idlea con consumo bajo de CPU/RAM y el volumen de 1 GB tiene un coste mínimo. Si usás mucho voice/media o ampliás el volumen, puede acercarse a los $3–5.
