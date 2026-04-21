import express from 'express';
import QRCode from 'qrcode';

/**
 * Create an Express router that exposes the WhatsApp pairing QR.
 *
 * Endpoints:
 *   GET /qr        -> HTML page with QR, status and auto-refresh
 *   GET /qr/image  -> PNG of the current QR (404 if none)
 *   GET /qr/status -> JSON { ready, hasQr, pairedAt, qrAgeMs }
 *
 * The caller owns the Express app and is responsible for mounting this router.
 *
 * @param {Object}   opts
 * @param {Object}   opts.waClient    - WhatsApp client. Must expose: isReady(),
 *                                      on('qr', (qr) => ...), on('ready', () => ...).
 * @param {Object}   opts.logger      - Logger with .info, .warn, .error, .debug.
 * @param {string}  [opts.bearerToken] - Optional shared token. When set, every
 *                                      endpoint requires either:
 *                                        Authorization: Bearer <token>  OR
 *                                        ?token=<token> in the query string.
 * @returns {import('express').Router}
 */
export function createQrRouter({ waClient, logger, bearerToken }) {
  if (!waClient || typeof waClient.on !== 'function' || typeof waClient.isReady !== 'function') {
    throw new Error('createQrRouter: waClient must implement on() and isReady()');
  }
  if (!logger) {
    throw new Error('createQrRouter: logger is required');
  }

  const router = express.Router();

  // --- Internal state -------------------------------------------------------
  let latestQr = null;
  let qrTime = null;      // ms epoch of the last QR
  let pairedAt = null;    // ms epoch when 'ready' fired

  // --- WA client listeners --------------------------------------------------
  waClient.on('qr', (qr) => {
    latestQr = qr;
    qrTime = Date.now();
    pairedAt = null;
    logger.info('[qr-endpoint] new QR received, awaiting pairing');
  });

  waClient.on('ready', () => {
    latestQr = null;
    qrTime = null;
    pairedAt = Date.now();
    logger.info('[qr-endpoint] waClient ready — device paired');
  });

  // --- Cookie parser (tiny, zero-dep) ---------------------------------------
  const parseCookie = (req) => {
    const raw = req.headers.cookie || '';
    const out = {};
    raw.split(';').forEach((p) => {
      const idx = p.indexOf('=');
      if (idx < 0) return;
      const k = p.slice(0, idx).trim();
      const v = p.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    });
    return out;
  };

  // --- GET /login?token=X ---------------------------------------------------
  // Sets HttpOnly cookie with the token and redirects to /qr (no query param
  // in URL — survives extensions that strip tracking params).
  router.get('/login', (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!bearerToken) {
      return res.redirect('/qr');
    }
    if (token !== bearerToken) {
      return res.status(401).send(
        '<html><body style="font-family:monospace;background:#0e0e0e;color:#e66;padding:40px"><h2>Unauthorized</h2><p>Invalid or missing token.</p></body></html>',
      );
    }
    // Set cookie for this path — 1h lifetime
    res.cookie('oc_token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 1000,
      path: '/',
    });
    res.redirect('/qr');
  });

  // --- Auth middleware ------------------------------------------------------
  const authMiddleware = (req, res, next) => {
    if (!bearerToken) return next();

    const header = req.get('authorization') || '';
    const headerToken = header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : null;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
    const cookies = parseCookie(req);
    const cookieToken = cookies.oc_token || null;

    if (
      headerToken === bearerToken ||
      queryToken === bearerToken ||
      cookieToken === bearerToken
    ) {
      return next();
    }

    logger.warn('[qr-endpoint] unauthorized request to %s', req.originalUrl);
    // If this is a browser hitting /qr with no auth, redirect to login page
    const wantsHtml = (req.get('accept') || '').includes('text/html');
    if (wantsHtml && req.path === '/qr') {
      return res.status(401).send(
        '<html><body style="font-family:monospace;background:#0e0e0e;color:#e6e6e6;padding:40px;text-align:center"><h2>OpenClaw — Unauthorized</h2><p>Use <code>/login?token=YOUR_TOKEN</code> to authenticate.</p></body></html>',
      );
    }
    res.status(401).json({ error: 'unauthorized' });
  };

  router.use(authMiddleware);

  // --- GET /qr/status -------------------------------------------------------
  router.get('/qr/status', (req, res) => {
    const ready = !!waClient.isReady();
    const hasQr = !ready && !!latestQr;
    res.json({
      ready,
      hasQr,
      pairedAt: pairedAt ?? null,
      qrAgeMs: qrTime ? Date.now() - qrTime : null,
    });
  });

  // --- GET /qr/image --------------------------------------------------------
  router.get('/qr/image', async (req, res) => {
    if (!latestQr) {
      return res.status(404).json({ error: 'no qr' });
    }
    try {
      const buffer = await QRCode.toBuffer(latestQr, { width: 512, margin: 2 });
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.send(buffer);
    } catch (err) {
      logger.error('[qr-endpoint] failed to render QR PNG: %s', err?.message || err);
      res.status(500).json({ error: 'qr render failed' });
    }
  });

  // --- GET /qr (HTML page) --------------------------------------------------
  router.get('/qr', (req, res) => {
    const token = bearerToken
      ? (typeof req.query.token === 'string' ? req.query.token : '')
      : '';
    const imageUrl = bearerToken
      ? `/qr/image?token=${encodeURIComponent(token)}`
      : `/qr/image`;
    const statusUrl = bearerToken
      ? `/qr/status?token=${encodeURIComponent(token)}`
      : `/qr/status`;

    const ready = !!waClient.isReady();

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenClaw — WhatsApp Pairing</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    min-height: 100vh;
    background: #0e0e0e;
    color: #e6e6e6;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace;
  }
  body {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px 16px;
    gap: 24px;
  }
  h1 {
    font-size: 20px;
    font-weight: 600;
    letter-spacing: 0.02em;
    margin: 0;
    color: #ffffff;
  }
  .card {
    background: #161616;
    border: 1px solid #2a2a2a;
    border-radius: 12px;
    padding: 28px;
    max-width: 560px;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
  }
  .status {
    font-size: 13px;
    color: #9a9a9a;
    text-align: center;
    line-height: 1.5;
  }
  .status.ok { color: #7ee787; }
  .status.warn { color: #f0b429; }
  .qr-wrap {
    background: #ffffff;
    padding: 14px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 300px;
    min-height: 300px;
  }
  .qr-wrap img {
    display: block;
    width: 100%;
    max-width: 420px;
    height: auto;
  }
  .instructions {
    font-size: 13px;
    color: #c9c9c9;
    text-align: center;
    line-height: 1.6;
  }
  .instructions strong { color: #ffffff; }
  .footer {
    font-size: 11px;
    color: #6a6a6a;
    text-align: center;
  }
  .hidden { display: none !important; }
  .spinner {
    width: 24px;
    height: 24px;
    border: 3px solid #333;
    border-top-color: #888;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <h1>OpenClaw — WhatsApp Pairing</h1>

  <div class="card">
    <div id="paired" class="status ok ${ready ? '' : 'hidden'}">
      ✅ Paired <span id="paired-time"></span>
    </div>

    <div id="qr-block" class="${ready || !latestQr ? 'hidden' : ''}">
      <div class="qr-wrap">
        <img id="qr-img" src="${imageUrl}" alt="WhatsApp pairing QR">
      </div>
    </div>

    <div id="waiting" class="status warn ${ready || latestQr ? 'hidden' : ''}">
      <div class="spinner" style="margin: 0 auto 12px;"></div>
      Waiting for connection… (retrying every 3s)
    </div>

    <div id="instructions" class="instructions ${ready || !latestQr ? 'hidden' : ''}">
      Open <strong>WhatsApp</strong> → <strong>Settings</strong> →
      <strong>Linked Devices</strong> → <strong>Link a Device</strong>
    </div>
  </div>

  <div class="footer">Status auto-refreshes every 3s.</div>

<script>
  (function () {
    var STATUS_URL = ${JSON.stringify(statusUrl)};
    var IMAGE_URL  = ${JSON.stringify(imageUrl)};
    var POLL_MS    = 3000;

    var pairedEl       = document.getElementById('paired');
    var pairedTimeEl   = document.getElementById('paired-time');
    var qrBlockEl      = document.getElementById('qr-block');
    var qrImgEl        = document.getElementById('qr-img');
    var waitingEl      = document.getElementById('waiting');
    var instructionsEl = document.getElementById('instructions');

    var prev = { ready: null, hasQr: null, pairedAt: null, qrAgeMs: null };
    var timer = null;
    var lastImageReload = 0;

    function fmtTime(ms) {
      if (!ms) return '';
      try { return new Date(ms).toLocaleString(); } catch (e) { return ''; }
    }

    function show(el, visible) {
      if (!el) return;
      if (visible) el.classList.remove('hidden');
      else el.classList.add('hidden');
    }

    function apply(status) {
      var ready = !!status.ready;
      var hasQr = !!status.hasQr;

      show(pairedEl, ready);
      show(qrBlockEl, !ready && hasQr);
      show(instructionsEl, !ready && hasQr);
      show(waitingEl, !ready && !hasQr);

      if (ready && status.pairedAt) {
        pairedTimeEl.textContent = '(' + fmtTime(status.pairedAt) + ')';
      }

      // Reload QR image when:
      //  - we transition to having a QR for the first time, OR
      //  - the QR age reset (Baileys rotated the QR — new one available)
      //  - fallback: 6s since last reload while QR still visible (safety net)
      var now = Date.now();
      var firstShow = (prev.hasQr !== hasQr) || (prev.ready !== ready);
      var qrAge = typeof status.qrAgeMs === 'number' ? status.qrAgeMs : null;
      var rotated = prev.qrAgeMs !== null && qrAge !== null && qrAge < prev.qrAgeMs;
      var staleReload = (now - lastImageReload) > 6000;

      if (!ready && hasQr && (firstShow || rotated || staleReload)) {
        qrImgEl.src = IMAGE_URL + (IMAGE_URL.indexOf('?') === -1 ? '?' : '&') + 't=' + now;
        lastImageReload = now;
      }

      if (ready && timer) {
        clearInterval(timer);
        timer = null;
      }

      prev = { ready: ready, hasQr: hasQr, pairedAt: status.pairedAt, qrAgeMs: qrAge };
    }

    function poll() {
      fetch(STATUS_URL, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j) apply(j); })
        .catch(function () { /* swallow — will retry */ });
    }

    poll();
    timer = setInterval(poll, POLL_MS);
  })();
</script>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(html);
  });

  return router;
}
