const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const qrcode  = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const PORT       = process.env.PORT || 3000;
const AUTH_DIR   = path.join(__dirname, '.wwebjs_auth');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOADS_DIR),
    filename:    (_, file, cb) =>
      cb(null, `${Date.now()}-${Math.round(Math.random()*1e6)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (_, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only')),
});

// ─── WhatsApp state ────────────────────────────────────────────────────────────
let whatsappReady  = false;
let latestQRDataUrl = null;
let clientName     = '';
let clientPhase    = 'init';

function broadcastPhase(phase, extra = {}) {
  clientPhase = phase;
  io.emit('wa-phase', { phase, ...extra });
  console.log('[WA]', phase, JSON.stringify(extra).slice(0, 80));
}

function clearSession() {
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
  console.log('[WA] session cleared');
}

// ─── Build WhatsApp client ─────────────────────────────────────────────────────
function buildClient() {
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--window-size=1280,800',
      ],
    },
    // Use live WhatsApp Web — when cache is empty the library loads directly
    // from web.whatsapp.com so the version is always current and valid
    webVersionCache: { type: 'local' },
    restartOnAuthFail: false,
  });

  c.on('qr', async (qr) => {
    try {
      latestQRDataUrl = await qrcode.toDataURL(qr, { scale: 6 });
      whatsappReady   = false;
      broadcastPhase('qr', { qr: latestQRDataUrl });
    } catch (e) { console.error('[QR gen]', e.message); }
  });

  c.on('authenticated', () => {
    latestQRDataUrl = null;
    broadcastPhase('authenticated');
  });

  c.on('ready', () => {
    whatsappReady   = true;
    latestQRDataUrl = null;
    clientName      = c.info?.pushname || 'User';
    broadcastPhase('ready', { name: clientName });
  });

  // Auth failure → clear stale session → restart process (Render restarts it automatically)
  c.on('auth_failure', (msg) => {
    console.error('[WA] auth_failure:', msg);
    broadcastPhase('failed', { reason: 'Session expired — reconnecting…' });
    clearSession();
    setTimeout(() => process.exit(1), 1500);
  });

  // Disconnected → restart process so a fresh QR is generated
  c.on('disconnected', (reason) => {
    console.log('[WA] disconnected:', reason);
    broadcastPhase('failed', { reason: `Disconnected (${reason}) — reconnecting…` });
    clearSession();
    setTimeout(() => process.exit(1), 1500);
  });

  return c;
}

let client = buildClient();
console.log('[WA] initializing…');
client.initialize().catch((e) => {
  console.error('[WA] init error:', e.message);
  clearSession();
  setTimeout(() => process.exit(1), 1500);
});

// ─── Socket.IO ──────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  // Push current state to newly connected browser immediately
  if      (clientPhase === 'ready')         socket.emit('wa-phase', { phase: 'ready', name: clientName });
  else if (clientPhase === 'qr' && latestQRDataUrl) socket.emit('wa-phase', { phase: 'qr', qr: latestQRDataUrl });
  else if (clientPhase === 'authenticated') socket.emit('wa-phase', { phase: 'authenticated' });
  else if (clientPhase === 'failed')        socket.emit('wa-phase', { phase: 'failed', reason: 'Reconnecting…' });
  else                                      socket.emit('wa-phase', { phase: 'init' });
});

// ─── REST API ──────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (_, res) => res.json({
  phase: clientPhase,
  ready: whatsappReady,
  name:  clientName || null,
  qr:    latestQRDataUrl || null,
}));

// Pairing code — lets the user link on the SAME phone (no QR scan needed)
app.post('/api/pair', async (req, res) => {
  if (whatsappReady)        return res.status(400).json({ error: 'Already connected.' });
  if (clientPhase !== 'qr') return res.status(400).json({ error: 'Not ready yet — wait for the QR to appear first, then try again.' });
  if (!client.pupPage)      return res.status(400).json({ error: 'Browser not ready yet, please wait.' });

  const clean = String(req.body.phone || '').replace(/\D/g, '');
  if (!clean || clean.length < 7 || clean.length > 15)
    return res.status(400).json({ error: 'Enter your full number with country code — digits only, no + or spaces.' });

  try {
    // In wwebjs v1.34+ requestPairingCode requires window.onCodeReceivedEvent to be
    // registered on the puppeteer page. It is only done automatically when the
    // pairWithPhoneNumber CLIENT OPTION is set. When calling the method standalone
    // (our case) we must register it ourselves first, otherwise it throws.
    await client.pupPage
      .exposeFunction('onCodeReceivedEvent', (code) => code)
      .catch(() => { /* already registered — that's fine */ });

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for pairing code — please try again.')), 30000)
    );
    const code = await Promise.race([client.requestPairingCode(clean), timeout]);
    const display = String(code).replace(/\W/g, '').toUpperCase();
    if (!display || display.length < 6)
      throw new Error('WhatsApp returned an empty code — please wait a few seconds and try again.');
    console.log(`[pair] code issued for ${clean.slice(0, 3)}***`);
    res.json({ code: display });
  } catch (e) {
    console.error('[pair] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Manual reset — clears session and restarts
app.post('/api/reset', (_, res) => {
  res.json({ ok: true, message: 'Resetting…' });
  clearSession();
  setTimeout(() => process.exit(1), 500);
});

// Upload images to WhatsApp Status
app.post('/api/upload', upload.array('images', 30), async (req, res) => {
  if (!whatsappReady) { cleanupFiles(req.files); return res.status(400).json({ error: 'WhatsApp not connected.' }); }
  if (!req.files?.length)                         return res.status(400).json({ error: 'No images provided.' });

  const socketId = req.headers['x-socket-id'];
  const results  = [];

  for (let i = 0; i < req.files.length; i++) {
    const file     = req.files[i];
    const progress = { current: i + 1, total: req.files.length, filename: file.originalname };
    try {
      const media = MessageMedia.fromFilePath(file.path);
      await client.sendMessage('status@broadcast', media, { caption: req.body.caption || '' });
      results.push({ filename: file.originalname, success: true });
      io.to(socketId).emit('upload-progress', { ...progress, success: true });
    } catch (e) {
      results.push({ filename: file.originalname, success: false, error: e.message });
      io.to(socketId).emit('upload-progress', { ...progress, success: false, error: e.message });
    } finally {
      fs.unlink(file.path, () => {});
    }
    if (i < req.files.length - 1) await new Promise(r => setTimeout(r, 1500));
  }

  const succeeded = results.filter(r => r.success).length;
  res.json({ total: results.length, succeeded, failed: results.length - succeeded, results });
});

function cleanupFiles(files = []) { files.forEach(f => fs.unlink(f.path, () => {})); }

server.listen(PORT, () => console.log(`[server] http://localhost:${PORT}`));
