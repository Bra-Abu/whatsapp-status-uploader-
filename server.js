const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ─── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  },
});

// ─── WhatsApp state ────────────────────────────────────────────────────────────
// These are cached so ANY newly-connected browser socket gets the current state immediately.
let whatsappReady = false;
let latestQRDataUrl = null;   // cached QR image so refreshed pages still see it
let clientName = '';
let clientPhase = 'init';     // 'init' | 'qr' | 'authenticated' | 'ready' | 'failed'

function broadcastPhase(phase, extra = {}) {
  clientPhase = phase;
  io.emit('wa-phase', { phase, ...extra });
  console.log('[WA phase]', phase, extra);
}

// ─── WhatsApp client ───────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    // On Linux servers (Render, Railway, etc.) set PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1280,800',
    ],
  },
  restartOnAuthFail: false,
});

client.on('qr', async (qr) => {
  try {
    latestQRDataUrl = await qrcode.toDataURL(qr, { scale: 6 });
    whatsappReady = false;
    broadcastPhase('qr', { qr: latestQRDataUrl });
  } catch (err) {
    console.error('QR generation error:', err);
  }
});

client.on('authenticated', () => {
  latestQRDataUrl = null; // QR no longer valid
  broadcastPhase('authenticated');
});

client.on('ready', () => {
  whatsappReady = true;
  latestQRDataUrl = null;
  clientName = client.info?.pushname || 'User';
  broadcastPhase('ready', { name: clientName });
});

client.on('auth_failure', (msg) => {
  whatsappReady = false;
  latestQRDataUrl = null;
  console.error('[WA] Auth failure:', msg);
  broadcastPhase('failed', { reason: 'Auth failed. Please restart the server.' });
});

client.on('disconnected', (reason) => {
  whatsappReady = false;
  latestQRDataUrl = null;
  console.log('[WA] Disconnected:', reason);
  broadcastPhase('failed', { reason: 'WhatsApp disconnected: ' + reason });
});

console.log('[WA] Initializing client (browser starting, please wait ~30s)…');
client.initialize();

// ─── Socket.IO ──────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[socket] connected:', socket.id);

  // Immediately bring this socket up to speed with the current state
  if (clientPhase === 'ready') {
    socket.emit('wa-phase', { phase: 'ready', name: clientName });
  } else if (clientPhase === 'qr' && latestQRDataUrl) {
    socket.emit('wa-phase', { phase: 'qr', qr: latestQRDataUrl });
  } else if (clientPhase === 'authenticated') {
    socket.emit('wa-phase', { phase: 'authenticated' });
  } else if (clientPhase === 'failed') {
    socket.emit('wa-phase', { phase: 'failed', reason: 'Connection failed. Please restart.' });
  } else {
    // Still initializing
    socket.emit('wa-phase', { phase: 'init' });
  }

  socket.on('disconnect', () => {
    console.log('[socket] disconnected:', socket.id);
  });
});

// ─── REST API ──────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Polled by the browser every few seconds as a reliable fallback
app.get('/api/status', (req, res) => {
  res.json({
    phase: clientPhase,
    ready: whatsappReady,
    name: clientName || null,
    hasQR: !!latestQRDataUrl,
  });
});

// Upload images → post to WhatsApp status one by one
app.post('/api/upload', upload.array('images', 30), async (req, res) => {
  if (!whatsappReady) {
    cleanupFiles(req.files);
    return res.status(400).json({ error: 'WhatsApp is not connected yet.' });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No images uploaded.' });
  }

  const socketId = req.headers['x-socket-id'];
  const results = [];

  for (let i = 0; i < req.files.length; i++) {
    const file = req.files[i];
    const progress = { current: i + 1, total: req.files.length, filename: file.originalname };

    try {
      const media = MessageMedia.fromFilePath(file.path);
      await client.sendMessage('status@broadcast', media, {
        caption: req.body.caption || '',
      });
      results.push({ filename: file.originalname, success: true });
      io.to(socketId).emit('upload-progress', { ...progress, success: true });
    } catch (err) {
      console.error(`[upload] failed ${file.originalname}:`, err.message);
      results.push({ filename: file.originalname, success: false, error: err.message });
      io.to(socketId).emit('upload-progress', { ...progress, success: false, error: err.message });
    } finally {
      fs.unlink(file.path, () => {});
    }

    if (i < req.files.length - 1) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  res.json({ total: results.length, succeeded, failed: results.length - succeeded, results });
});

function cleanupFiles(files = []) {
  files.forEach((f) => fs.unlink(f.path, () => {}));
}

server.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
});
