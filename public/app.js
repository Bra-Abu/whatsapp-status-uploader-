const socket = io({ transports: ['websocket', 'polling'] });

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const connectionBadge = document.getElementById('connection-badge');
const qrSection       = document.getElementById('qr-section');
const qrContainer     = document.getElementById('qr-container');
const qrMsg           = document.getElementById('qr-msg');
const uploadSection   = document.getElementById('upload-section');
const dropZone        = document.getElementById('drop-zone');
const fileInput       = document.getElementById('file-input');
const previewGrid     = document.getElementById('preview-grid');
const actionRow       = document.getElementById('action-row');
const clearBtn        = document.getElementById('clear-btn');
const uploadBtn       = document.getElementById('upload-btn');
const uploadBtnText   = document.getElementById('upload-btn-text');
const captionInput    = document.getElementById('caption');
const progressSection = document.getElementById('progress-section');
const progressBar     = document.getElementById('progress-bar');
const progressText    = document.getElementById('progress-text');
const resultsList     = document.getElementById('results-list');
const toast           = document.getElementById('toast');

// ─── State ─────────────────────────────────────────────────────────────────────
let selectedFiles = [];
let isUploading   = false;
let isConnected   = false;
let uploadDone    = false; // true after a batch completes; resets when new images are added

// ─── Phase handler — single source of truth ────────────────────────────────────
function applyPhase({ phase, qr, name, reason }) {
  switch (phase) {
    case 'init':
      setQRMsg('Starting WhatsApp browser, please wait…');
      break;

    case 'qr':
      if (qr) {
        qrContainer.innerHTML = `<img src="${qr}" alt="WhatsApp QR Code" style="width:240px;height:240px;border-radius:8px;border:3px solid #e9edef;" />`;
      }
      setQRMsg('Ready — scan with your phone');
      break;

    case 'authenticated':
      setQRMsg('Authenticated! Loading WhatsApp…');
      break;

    case 'ready':
      if (!isConnected) {
        isConnected = true;
        showConnected(name || 'User');
      }
      break;

    case 'failed':
      setQRMsg(reason || 'Connection failed. Please restart the server.');
      connectionBadge.textContent = 'Error';
      connectionBadge.className = 'badge error';
      break;
  }
}

// ─── Socket events ─────────────────────────────────────────────────────────────
socket.on('wa-phase', applyPhase);

// When socket reconnects, ask server for current state immediately
socket.on('connect', () => {
  console.log('[socket] connected, id:', socket.id);
  // The server will push the current phase automatically on connect.
  // But also poll once right away as belt-and-suspenders.
  pollStatus();
});

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
    uploadDone = true;           // lock the button until fresh images are added
    uploadBtn.disabled = true;
    uploadBtnText.textContent = 'Upload to Status';
    showToast(`Done! ${current} image${current > 1 ? 's' : ''} processed. Drop new images to upload again.`);
  }
});

// ─── Polling fallback (runs every 3 s, stops once connected) ───────────────────
async function pollStatus() {
  if (isConnected) return;
  try {
    const { phase, name, qr } = await fetch('/api/status').then((r) => r.json());
    applyPhase({ phase, name, qr });
  } catch (_) { /* ignore */ }
}

setInterval(pollStatus, 3000);
pollStatus(); // also run immediately on page load

// ─── UI helpers ────────────────────────────────────────────────────────────────
function setQRMsg(text) {
  if (qrMsg) qrMsg.textContent = text;
}

function showConnected(name) {
  connectionBadge.textContent = `Connected · ${name}`;
  connectionBadge.className = 'badge connected';
  qrSection.classList.add('hidden');
  uploadSection.classList.remove('hidden');
}

// ─── File selection ─────────────────────────────────────────────────────────────
function addFiles(files) {
  const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
  if (imageFiles.length === 0) return showToast('Please select image files only.');
  uploadDone = false; // new images → unlock the button

  const toAdd = imageFiles.slice(0, 30 - selectedFiles.length);
  if (toAdd.length < imageFiles.length) {
    showToast(`Max 30 images. Added ${toAdd.length} of ${imageFiles.length}.`);
  }

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
  removeBtn.title = 'Remove';
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
  // Active only when there are files AND we haven't just finished an upload batch
  uploadBtn.disabled = !hasFiles || uploadDone || isUploading;
}

fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

dropZone.addEventListener('click', (e) => {
  if (!e.target.closest('label')) fileInput.click();
});
dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  addFiles(e.dataTransfer.files);
});

// ─── Clear ─────────────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  if (isUploading) return;
  selectedFiles = [];
  uploadDone = false;
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
    const overlay = el.querySelector('.status-overlay');
    if (overlay) overlay.textContent = '';
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
