const socket = io({ transports: ['websocket', 'polling'] });

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const connectionBadge  = document.getElementById('connection-badge');
const qrSection        = document.getElementById('qr-section');
const qrContainer      = document.getElementById('qr-container');
const qrMsg            = document.getElementById('qr-msg');
const uploadSection    = document.getElementById('upload-section');
const dropZone         = document.getElementById('drop-zone');
const fileInput        = document.getElementById('file-input');
const previewGrid      = document.getElementById('preview-grid');
const actionRow        = document.getElementById('action-row');
const clearBtn         = document.getElementById('clear-btn');
const uploadBtn        = document.getElementById('upload-btn');
const uploadBtnText    = document.getElementById('upload-btn-text');
const captionInput     = document.getElementById('caption');
const progressSection  = document.getElementById('progress-section');
const progressBar      = document.getElementById('progress-bar');
const progressText     = document.getElementById('progress-text');
const resultsList      = document.getElementById('results-list');
const toast            = document.getElementById('toast');
// Auth tabs
const tabQRBtn         = document.getElementById('tab-qr-btn');
const tabPhoneBtn      = document.getElementById('tab-phone-btn');
const tabQR            = document.getElementById('tab-qr');
const tabPhone         = document.getElementById('tab-phone');
// Pairing
const phoneInput       = document.getElementById('phone-input');
const pairBtn          = document.getElementById('pair-btn');
const pairResult       = document.getElementById('pair-result');
const pairCodeValue    = document.getElementById('pair-code-value');
const pairRefreshBtn   = document.getElementById('pair-refresh-btn');

// ─── State ─────────────────────────────────────────────────────────────────────
let selectedFiles = [];
let isUploading   = false;
let isConnected   = false;
let uploadDone    = false;

// ─── Tab switching ──────────────────────────────────────────────────────────────
function activateTab(tab) {
  const isQR = tab === 'qr';
  tabQRBtn.classList.toggle('active', isQR);
  tabPhoneBtn.classList.toggle('active', !isQR);
  tabQR.classList.toggle('hidden', !isQR);
  tabPhone.classList.toggle('hidden', isQR);
}

// On touch/mobile devices default to the phone-number tab
const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
activateTab(isTouchDevice ? 'phone' : 'qr');

tabQRBtn.addEventListener('click',    () => activateTab('qr'));
tabPhoneBtn.addEventListener('click', () => activateTab('phone'));

// ─── Pairing code ───────────────────────────────────────────────────────────────
async function requestPairingCode() {
  const phone = phoneInput.value.replace(/\D/g, '').trim();
  if (!phone) return showToast('Enter your WhatsApp phone number with country code');

  pairBtn.disabled = true;
  pairBtn.textContent = 'Getting code…';
  pairResult.classList.add('hidden');

  try {
    const resp = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to get pairing code');

    // Format as "XXXX XXXX"
    const raw = data.code.replace(/\W/g, '');
    pairCodeValue.textContent = raw.slice(0, 4) + ' ' + raw.slice(4);
    pairResult.classList.remove('hidden');
  } catch (err) {
    showToast(err.message);
  } finally {
    pairBtn.disabled = false;
    pairBtn.textContent = 'Get Code';
  }
}

pairBtn.addEventListener('click', requestPairingCode);
pairRefreshBtn.addEventListener('click', requestPairingCode);
phoneInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') requestPairingCode(); });

// ─── Phase handler — single source of truth ────────────────────────────────────
function applyPhase({ phase, qr, name, reason }) {
  switch (phase) {
    case 'init':
      setQRMsg('Starting WhatsApp, please wait…');
      break;

    case 'qr':
      if (qr) {
        qrContainer.innerHTML =
          `<img src="${qr}" alt="WhatsApp QR Code" />`;
      }
      setQRMsg('Scan with WhatsApp on another device');
      break;

    case 'authenticated':
      setQRMsg('Authenticated! Loading…');
      pairResult.classList.add('hidden');
      break;

    case 'ready':
      if (!isConnected) {
        isConnected = true;
        showConnected(name || 'User');
      }
      break;

    case 'failed':
      setQRMsg(reason || 'Connection failed. Please restart.');
      connectionBadge.textContent = 'Error';
      connectionBadge.className = 'badge error';
      break;
  }
}

// ─── Socket events ─────────────────────────────────────────────────────────────
socket.on('wa-phase', applyPhase);

socket.on('connect', () => { pollStatus(); });

socket.on('upload-progress', ({ current, total, filename, success, error }) => {
  const pct = Math.round((current / total) * 100);
  progressBar.style.width = pct + '%';
  progressText.textContent = `${current} / ${total} uploaded`;

  const item = previewGrid.querySelector(`[data-filename="${CSS.escape(filename)}"]`);
  if (item) {
    item.classList.remove('uploading');
    item.classList.add(success ? 'success' : 'failed');
    const overlay = item.querySelector('.status-overlay');
    if (overlay) overlay.textContent = success ? '✓' : '✗';
  }

  const li = document.createElement('li');
  li.className = success ? 'ok' : 'err';
  li.textContent = success ? `✓ ${filename}` : `✗ ${filename} — ${error || 'Failed'}`;
  resultsList.appendChild(li);

  if (current === total) {
    isUploading = false;
    uploadDone  = true;
    uploadBtn.disabled = true;
    uploadBtnText.textContent = 'Upload to Status';
    showToast(`Done! ${current} image${current > 1 ? 's' : ''} processed. Drop new images to upload again.`);
  }
});

// ─── Polling fallback ──────────────────────────────────────────────────────────
async function pollStatus() {
  if (isConnected) return;
  try {
    const { phase, name, qr } = await fetch('/api/status').then((r) => r.json());
    applyPhase({ phase, name, qr });
  } catch (_) { /* ignore */ }
}
setInterval(pollStatus, 3000);
pollStatus();

// ─── UI helpers ────────────────────────────────────────────────────────────────
function setQRMsg(text) { if (qrMsg) qrMsg.textContent = text; }

function showConnected(name) {
  connectionBadge.textContent = `Connected · ${name}`;
  connectionBadge.className = 'badge connected';
  qrSection.classList.add('hidden');
  uploadSection.classList.remove('hidden');
}

// ─── Drop zone text for touch ──────────────────────────────────────────────────
if (isTouchDevice) {
  const dt = document.getElementById('drop-text');
  if (dt) dt.textContent = 'Tap to select photos, or';
}

// ─── File selection ─────────────────────────────────────────────────────────────
function addFiles(files) {
  const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
  if (imageFiles.length === 0) return showToast('Please select image files only.');
  uploadDone = false;

  const toAdd = imageFiles.slice(0, 30 - selectedFiles.length);
  if (toAdd.length < imageFiles.length)
    showToast(`Max 30 images. Added ${toAdd.length} of ${imageFiles.length}.`);

  toAdd.forEach((file) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    selectedFiles.push({ file, id });
    renderPreviewItem(file, id);
  });
  updateUI();
}

function renderPreviewItem(file, id) {
  const item = document.createElement('div');
  item.className = 'preview-item';
  item.dataset.id = id;
  item.dataset.filename = file.name;

  const img = document.createElement('img');
  img.src = URL.createObjectURL(file);
  img.alt = file.name;

  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-btn';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => removeFile(id));

  const overlay = document.createElement('div');
  overlay.className = 'status-overlay';

  item.append(img, removeBtn, overlay);
  previewGrid.appendChild(item);
}

function removeFile(id) {
  if (isUploading) return;
  selectedFiles = selectedFiles.filter((f) => f.id !== id);
  previewGrid.querySelector(`[data-id="${id}"]`)?.remove();
  updateUI();
}

function updateUI() {
  const hasFiles = selectedFiles.length > 0;
  previewGrid.classList.toggle('hidden', !hasFiles);
  actionRow.classList.toggle('hidden', !hasFiles);
  uploadBtn.disabled = !hasFiles || uploadDone || isUploading;
}

fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

dropZone.addEventListener('click',    (e) => { if (!e.target.closest('label')) fileInput.click(); });
dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop',      (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  addFiles(e.dataTransfer.files);
});

// ─── Clear ─────────────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  if (isUploading) return;
  selectedFiles = [];
  uploadDone    = false;
  previewGrid.innerHTML = '';
  resultsList.innerHTML = '';
  progressSection.classList.add('hidden');
  progressBar.style.width = '0%';
  updateUI();
});

// ─── Upload ─────────────────────────────────────────────────────────────────────
uploadBtn.addEventListener('click', async () => {
  if (isUploading || selectedFiles.length === 0) return;

  isUploading = true;
  uploadBtn.disabled = true;
  uploadBtnText.textContent = 'Uploading…';

  progressSection.classList.remove('hidden');
  progressBar.style.width = '0%';
  progressText.textContent = `0 / ${selectedFiles.length} uploaded`;
  resultsList.innerHTML = '';

  previewGrid.querySelectorAll('.preview-item').forEach((el) => {
    el.className = 'preview-item uploading';
    const ov = el.querySelector('.status-overlay');
    if (ov) ov.textContent = '';
  });

  const formData = new FormData();
  selectedFiles.forEach(({ file }) => formData.append('images', file));
  formData.append('caption', captionInput.value);

  try {
    const resp = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'x-socket-id': socket.id },
      body: formData,
    });
    if (!resp.ok) {
      const { error } = await resp.json();
      throw new Error(error || 'Upload failed');
    }
  } catch (err) {
    showToast(err.message);
    isUploading = false;
    uploadBtn.disabled = false;
    uploadBtnText.textContent = 'Upload to Status';
  }
});

// ─── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, ms = 3500) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), ms);
}
