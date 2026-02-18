const socket = io({ transports: ['websocket', 'polling'] });

// ─── DOM ───────────────────────────────────────────────────────────────────────
const badge          = document.getElementById('connection-badge');
const qrSection      = document.getElementById('qr-section');
const qrContainer    = document.getElementById('qr-container');
const qrMsg          = document.getElementById('qr-msg');
const uploadSection  = document.getElementById('upload-section');
const tabQRBtn       = document.getElementById('tab-qr-btn');
const tabPhoneBtn    = document.getElementById('tab-phone-btn');
const tabQR          = document.getElementById('tab-qr');
const tabPhone       = document.getElementById('tab-phone');
const phoneInput     = document.getElementById('phone-input');
const pairBtn        = document.getElementById('pair-btn');
const pairResult     = document.getElementById('pair-result');
const pairCodeValue  = document.getElementById('pair-code-value');
const pairRefreshBtn = document.getElementById('pair-refresh-btn');
const pairStatusMsg  = document.getElementById('pair-status-msg');
const dropZone       = document.getElementById('drop-zone');
const fileInput      = document.getElementById('file-input');
const previewGrid    = document.getElementById('preview-grid');
const actionRow      = document.getElementById('action-row');
const clearBtn       = document.getElementById('clear-btn');
const uploadBtn      = document.getElementById('upload-btn');
const uploadBtnText  = document.getElementById('upload-btn-text');
const captionInput   = document.getElementById('caption');
const progressSection= document.getElementById('progress-section');
const progressBar    = document.getElementById('progress-bar');
const progressText   = document.getElementById('progress-text');
const resultsList    = document.getElementById('results-list');
const toast          = document.getElementById('toast');

// ─── State ─────────────────────────────────────────────────────────────────────
let selectedFiles = [], isUploading = false, isConnected = false, uploadDone = false;

// ─── Tabs ──────────────────────────────────────────────────────────────────────
const isTouch = window.matchMedia('(hover:none) and (pointer:coarse)').matches;

function activateTab(tab) {
  const isQR = tab === 'qr';
  tabQRBtn.classList.toggle('active', isQR);
  tabPhoneBtn.classList.toggle('active', !isQR);
  tabQR.classList.toggle('hidden', !isQR);
  tabPhone.classList.toggle('hidden', isQR);
}
// Mobile defaults to "Same Phone" tab; desktop to QR
activateTab(isTouch ? 'phone' : 'qr');
tabQRBtn.addEventListener('click',    () => activateTab('qr'));
tabPhoneBtn.addEventListener('click', () => activateTab('phone'));

// ─── Phase handler ─────────────────────────────────────────────────────────────
function applyPhase({ phase, qr, name, reason }) {
  switch (phase) {
    case 'init':
      setQRMsg('Starting WhatsApp, please wait…');
      setPairMsg('');
      break;
    case 'qr':
      if (qr) qrContainer.innerHTML = `<img src="${qr}" alt="QR Code" />`;
      setQRMsg('Ready to scan');
      setPairMsg('WhatsApp is ready — enter your number and tap Get Code.');
      break;
    case 'authenticated':
      setQRMsg('Authenticated, loading…');
      setPairMsg('Authenticated! Loading…');
      pairResult.classList.add('hidden');
      break;
    case 'ready':
      if (!isConnected) { isConnected = true; showConnected(name || 'User'); }
      break;
    case 'failed':
      setQRMsg(reason || 'Connection failed — reconnecting…');
      setPairMsg(reason || 'Connection failed — reconnecting…');
      badge.textContent = 'Error';
      badge.className = 'badge error';
      break;
  }
}

// ─── Socket ────────────────────────────────────────────────────────────────────
socket.on('wa-phase', applyPhase);
socket.on('connect',  () => pollStatus());

socket.on('upload-progress', ({ current, total, filename, success, error }) => {
  progressBar.style.width = Math.round(current/total*100) + '%';
  progressText.textContent = `${current} / ${total} uploaded`;

  const item = previewGrid.querySelector(`[data-filename="${CSS.escape(filename)}"]`);
  if (item) {
    item.classList.remove('uploading');
    item.classList.add(success ? 'success' : 'failed');
    const ov = item.querySelector('.status-overlay');
    if (ov) ov.textContent = success ? '✓' : '✗';
  }

  const li = document.createElement('li');
  li.className = success ? 'ok' : 'err';
  li.textContent = success ? `✓ ${filename}` : `✗ ${filename} — ${error||'Failed'}`;
  resultsList.appendChild(li);

  if (current === total) {
    isUploading = false; uploadDone = true;
    uploadBtn.disabled = true;
    uploadBtnText.textContent = 'Upload to Status';
    showToast(`Done! ${current} image${current>1?'s':''} uploaded. Drop new photos to upload again.`);
  }
});

// ─── Polling fallback ──────────────────────────────────────────────────────────
async function pollStatus() {
  if (isConnected) return;
  try {
    const { phase, name, qr } = await fetch('/api/status').then(r => r.json());
    applyPhase({ phase, name, qr });
  } catch (_) {}
}
setInterval(pollStatus, 3000);
pollStatus();

// ─── UI helpers ────────────────────────────────────────────────────────────────
function setQRMsg(t)   { if (qrMsg) qrMsg.textContent = t; }
function setPairMsg(t) { if (pairStatusMsg) pairStatusMsg.textContent = t; }

function showConnected(name) {
  badge.textContent = `Connected · ${name}`;
  badge.className = 'badge connected';
  qrSection.classList.add('hidden');
  uploadSection.classList.remove('hidden');
}

// ─── Pairing code ──────────────────────────────────────────────────────────────
async function requestPairingCode() {
  const phone = (phoneInput.value || '').replace(/\D/g,'').trim();
  if (!phone) return showToast('Enter your WhatsApp number with country code');

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
    if (!resp.ok) throw new Error(data.error || 'Failed');

    const raw = String(data.code).replace(/\W/g,'');
    pairCodeValue.textContent = raw.slice(0,4) + ' ' + raw.slice(4);
    pairResult.classList.remove('hidden');
    setPairMsg('');
  } catch (e) {
    showToast(e.message);
  } finally {
    pairBtn.disabled = false;
    pairBtn.textContent = 'Get Code';
  }
}

pairBtn.addEventListener('click', requestPairingCode);
pairRefreshBtn.addEventListener('click', requestPairingCode);
phoneInput.addEventListener('keydown', e => { if (e.key === 'Enter') requestPairingCode(); });

// ─── Files ─────────────────────────────────────────────────────────────────────
function addFiles(files) {
  const imgs = Array.from(files).filter(f => f.type.startsWith('image/'));
  if (!imgs.length) return showToast('Please select image files only.');
  uploadDone = false;

  const toAdd = imgs.slice(0, 30 - selectedFiles.length);
  if (toAdd.length < imgs.length) showToast(`Max 30 images. Added ${toAdd.length}.`);

  toAdd.forEach(file => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    selectedFiles.push({ file, id });
    const item = document.createElement('div');
    item.className = 'preview-item';
    item.dataset.id = id;
    item.dataset.filename = file.name;
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    const rm = document.createElement('button');
    rm.className = 'remove-btn'; rm.textContent = '✕';
    rm.addEventListener('click', () => removeFile(id));
    const ov = document.createElement('div');
    ov.className = 'status-overlay';
    item.append(img, rm, ov);
    previewGrid.appendChild(item);
  });
  updateUI();
}

function removeFile(id) {
  if (isUploading) return;
  selectedFiles = selectedFiles.filter(f => f.id !== id);
  previewGrid.querySelector(`[data-id="${id}"]`)?.remove();
  updateUI();
}

function updateUI() {
  const has = selectedFiles.length > 0;
  previewGrid.classList.toggle('hidden', !has);
  actionRow.classList.toggle('hidden', !has);
  uploadBtn.disabled = !has || uploadDone || isUploading;
}

fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
dropZone.addEventListener('click',    e => { if (!e.target.closest('label')) fileInput.click(); });
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop',      e => { e.preventDefault(); dropZone.classList.remove('drag-over'); addFiles(e.dataTransfer.files); });

clearBtn.addEventListener('click', () => {
  if (isUploading) return;
  selectedFiles = []; uploadDone = false;
  previewGrid.innerHTML = ''; resultsList.innerHTML = '';
  progressSection.classList.add('hidden');
  progressBar.style.width = '0%';
  updateUI();
});

// ─── Upload ────────────────────────────────────────────────────────────────────
uploadBtn.addEventListener('click', async () => {
  if (isUploading || !selectedFiles.length) return;
  isUploading = true;
  uploadBtn.disabled = true;
  uploadBtnText.textContent = 'Uploading…';
  progressSection.classList.remove('hidden');
  progressBar.style.width = '0%';
  progressText.textContent = `0 / ${selectedFiles.length} uploaded`;
  resultsList.innerHTML = '';

  previewGrid.querySelectorAll('.preview-item').forEach(el => {
    el.className = 'preview-item uploading';
    const ov = el.querySelector('.status-overlay');
    if (ov) ov.textContent = '';
  });

  const fd = new FormData();
  selectedFiles.forEach(({ file }) => fd.append('images', file));
  fd.append('caption', captionInput.value);

  try {
    const resp = await fetch('/api/upload', { method: 'POST', headers: { 'x-socket-id': socket.id }, body: fd });
    if (!resp.ok) { const { error } = await resp.json(); throw new Error(error || 'Upload failed'); }
  } catch (e) {
    showToast(e.message);
    isUploading = false; uploadBtn.disabled = false;
    uploadBtnText.textContent = 'Upload to Status';
  }
});

// ─── Toast ─────────────────────────────────────────────────────────────────────
let toastT;
function showToast(msg, ms = 4000) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastT);
  toastT = setTimeout(() => toast.classList.add('hidden'), ms);
}
