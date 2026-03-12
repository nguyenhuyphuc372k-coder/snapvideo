/* ========== Shared helpers ========== */
const T = window.T || {};
function $(sel, ctx = document) { return ctx.querySelector(sel); }
function $$(sel, ctx = document) { return [...ctx.querySelectorAll(sel)]; }

function setStatus(msg, isError, isSuccess) {
  const el = $('#status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'status' + (isError ? ' error' : '') + (isSuccess ? ' success' : '');
}

function setLoading(msg) {
  const el = $('#status');
  if (!el) return;
  el.innerHTML = '<span class="spinner"></span>' + msg;
  el.className = 'status';
}

function formatDuration(s) {
  if (!s) return '';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

function formatBytes(b) {
  if (!b) return '';
  return b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
}

/* ========== FAQ accordion ========== */
document.addEventListener('DOMContentLoaded', () => {
  // Warm up server (helps reduce cold start delay on free hosting)
  try {
    fetch('/api/ping', { cache: 'no-store' }).catch(() => {});
  } catch {}

  $$('.faq-q').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      item.classList.toggle('open');
    });
  });
});

/* ========== Video Downloader (generic + youtube) ========== */
let currentUrl = '';
let selectedFormat = 'best';
let downloadMode = 'mp4'; // mp4 or mp3

async function fetchVideoInfo() {
  const url = ($('#urlInput') || {}).value?.trim();
  if (!url) return setStatus(T.statusPleaseUrl || 'Please paste a video URL', true);

  currentUrl = url;
  const fetchBtn = $('#fetchBtn');
  const resultBox = $('#resultBox');
  if (fetchBtn) fetchBtn.disabled = true;
  if (resultBox) resultBox.classList.remove('show');
  setLoading(T.statusFetching || 'Fetching video info...');

  try {
    const res = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) { setStatus(data.error || T.statusError || 'Error', true); if (fetchBtn) fetchBtn.disabled = false; return; }

    // Populate result
    const thumb = $('#thumbnail');
    if (thumb) { if (data.thumbnail) { thumb.src = data.thumbnail; thumb.style.display = ''; } else { thumb.style.display = 'none'; } }

    const titleEl = $('#videoTitle');
    if (titleEl) titleEl.textContent = data.title;

    const metaEl = $('#videoMeta');
    if (metaEl) {
      const parts = [];
      if (data.platform) parts.push(data.platform);
      if (data.uploader) parts.push(data.uploader);
      if (data.duration) parts.push(formatDuration(data.duration));
      metaEl.textContent = parts.join(' · ');
    }

    // Formats
    const fmtList = $('#formatsList');
    if (fmtList && data.formats) {
      fmtList.innerHTML = '';
      selectedFormat = data.formats[0]?.formatId || 'best';
      data.formats.forEach((f, i) => {
        const pill = document.createElement('button');
        pill.className = 'format-pill' + (i === 0 ? ' active' : '');
        let label = f.resolution;
        if (f.filesize) label += ' (' + formatBytes(f.filesize) + ')';
        pill.textContent = label;
        pill.onclick = () => {
          selectedFormat = f.formatId;
          $$('.format-pill', fmtList).forEach(p => p.classList.remove('active'));
          pill.classList.add('active');
        };
        fmtList.appendChild(pill);
      });
    }

    if (resultBox) resultBox.classList.add('show');
    setStatus(T.statusVideoReady || 'Video ready! Choose quality and download ✓', false, true);
    // Auto-scroll to result on mobile
    setTimeout(() => { if (resultBox) resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 150);
  } catch { setStatus(T.statusConnectionError || 'Connection error', true); }
  if (fetchBtn) fetchBtn.disabled = false;
}

/* ========== Progress bar helpers ========== */
function showProgress(percent, speed, eta) {
  const wrap = $('#progressWrap');
  const bar = $('#progressBar');
  const text = $('#progressText');
  const spd = $('#progressSpeed');
  const etaEl = $('#progressEta');
  if (wrap) wrap.classList.add('show');
  if (bar) bar.style.width = Math.min(percent, 100) + '%';
  if (text) text.textContent = Math.round(percent) + '%';
  if (spd) spd.textContent = speed ? '⚡ ' + speed : '';
  if (etaEl) etaEl.textContent = eta ? 'ETA ' + eta : '';
}
function hideProgress() {
  const wrap = $('#progressWrap');
  if (wrap) wrap.classList.remove('show');
}

function pollProgress(jobId) {
  return new Promise((resolve, reject) => {
    const iv = setInterval(async () => {
      try {
        const r = await fetch('/api/progress/' + jobId);
        const d = await r.json();
        if (d.status === 'downloading') {
          showProgress(d.percent, d.speed, d.eta);
        } else if (d.status === 'done') {
          showProgress(100, '', '');
          clearInterval(iv);
          resolve(d);
        } else if (d.status === 'error') {
          clearInterval(iv);
          reject(new Error('Download failed'));
        } else {
          clearInterval(iv);
          reject(new Error('Unknown job'));
        }
      } catch { clearInterval(iv); reject(new Error('Connection error')); }
    }, 500);
  });
}

async function downloadVideo() {
  if (!currentUrl) return;
  const btn = $('#downloadBtn');
  if (btn) btn.disabled = true;
  setStatus(T.statusProcessing || 'Processing download...', false);
  showProgress(0, '', '');

  const endpoint = downloadMode === 'mp3' ? '/api/download-mp3' : '/api/download';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: currentUrl, formatId: selectedFormat })
    });
    const data = await res.json();
    if (!res.ok) { setStatus(data.error || T.statusError || 'Download failed', true); hideProgress(); if (btn) btn.disabled = false; return; }

    const result = await pollProgress(data.jobId);
    hideProgress();
    const a = document.createElement('a');
    a.href = result.downloadUrl;
    a.download = result.filename || 'video.mp4';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setStatus(T.statusDownloadStarted || 'Download started ✓', false, true);
  } catch (e) {
    hideProgress();
    setStatus(e.message === 'Download failed' ? (T.statusError || 'Download failed') : (T.statusConnectionError || 'Connection error'), true);
  }
  if (btn) btn.disabled = false;
}

/* ========== YouTube tabs ========== */
function switchTab(mode) {
  downloadMode = mode;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  const fmtSection = $('#formatSection');
  if (fmtSection) fmtSection.style.display = mode === 'mp3' ? 'none' : '';
}

/* ========== Thumbnail downloader ========== */
async function fetchThumbnail() {
  const url = ($('#urlInput') || {}).value?.trim();
  if (!url) return setStatus(T.statusPleaseUrl || 'Please paste a video URL', true);

  const btn = $('#fetchBtn');
  if (btn) btn.disabled = true;
  setLoading(T.statusFetching || 'Fetching thumbnail...');

  try {
    const res = await fetch('/api/thumbnail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) { setStatus(data.error || T.statusError || 'Error', true); if (btn) btn.disabled = false; return; }

    const preview = $('#thumbPreview');
    const img = $('#thumbImg');
    const dlBtn = $('#thumbDownload');
    if (img) img.src = data.thumbnail;
    if (dlBtn) dlBtn.href = data.thumbnail;
    if (preview) preview.classList.add('show');
    setStatus('');
  } catch { setStatus(T.statusConnectionError || 'Connection error', true); }
  if (btn) btn.disabled = false;
}

/* ========== Audio converter (URL mode) ========== */
async function convertUrlToAudio() {
  const url = ($('#urlInput') || {}).value?.trim();
  if (!url) return setStatus(T.statusPleaseUrl || 'Please paste a video URL', true);

  const btn = $('#convertBtn');
  if (btn) btn.disabled = true;
  setStatus(T.statusProcessing || 'Extracting audio...', false);
  showProgress(0, '', '');

  try {
    const res = await fetch('/api/download-mp3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) { setStatus(data.error || T.statusError || 'Error', true); hideProgress(); if (btn) btn.disabled = false; return; }

    const result = await pollProgress(data.jobId);
    hideProgress();
    const a = document.createElement('a');
    a.href = result.downloadUrl;
    a.download = result.filename || 'audio.mp3';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setStatus(T.statusDownloadStarted || 'Download started ✓', false, true);
  } catch (e) {
    hideProgress();
    setStatus(e.message === 'Download failed' ? (T.statusError || 'Error') : (T.statusConnectionError || 'Connection error'), true);
  }
  if (btn) btn.disabled = false;
}

/* ========== File upload converter ========== */
async function convertFile() {
  const fileInput = $('#fileInput');
  if (!fileInput || !fileInput.files[0]) return setStatus(T.statusSelectFile || 'Please select a file', true);

  const btn = $('#convertFileBtn');
  if (btn) btn.disabled = true;
  setLoading(T.statusProcessing || 'Converting...');

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('format', 'mp3');

  try {
    const res = await fetch('/api/convert', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) { setStatus(data.error || T.statusError || 'Conversion failed', true); if (btn) btn.disabled = false; return; }

    const a = document.createElement('a');
    a.href = data.downloadUrl;
    a.download = data.filename || 'audio.mp3';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setStatus(T.statusDownloadStarted || 'Conversion complete ✓');
  } catch { setStatus(T.statusConnectionError || 'Connection error', true); }
  if (btn) btn.disabled = false;
}

/* ========== Subtitle downloader ========== */
async function fetchSubtitles() {
  const url = ($('#urlInput') || {}).value?.trim();
  if (!url) return setStatus(T.statusPleaseUrl || 'Please paste a video URL', true);

  const btn = $('#fetchBtn');
  if (btn) btn.disabled = true;
  setLoading(T.statusFetching || 'Fetching subtitles...');

  try {
    const res = await fetch('/api/subtitles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) { setStatus(data.error || T.statusError || 'Error', true); if (btn) btn.disabled = false; return; }

    const list = $('#subtitlesList');
    if (list && data.subtitles) {
      list.innerHTML = '';
      if (data.subtitles.length === 0) {
        list.innerHTML = '<p style="color:#999;font-size:0.88rem">' + (T.noSubsFound || 'No subtitles found for this video.') + '</p>';
      } else {
        data.subtitles.forEach(sub => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)';
          const label = document.createElement('span');
          label.style.fontSize = '0.9rem';
          label.textContent = sub.lang;
          const link = document.createElement('a');
          link.href = '/api/subtitle-file?url=' + encodeURIComponent(url) + '&lang=' + encodeURIComponent(sub.code);
          link.className = 'btn';
          link.style.cssText = 'padding:6px 16px;font-size:0.8rem';
          link.download = '';
          link.textContent = T.downloadSrt || 'Download .srt';
          row.appendChild(label);
          row.appendChild(link);
          list.appendChild(row);
        });
      }
      list.style.display = 'block';
    }
    setStatus('');
  } catch { setStatus(T.statusConnectionError || 'Connection error', true); }
  if (btn) btn.disabled = false;
}

/* ========== Video trimmer ========== */
function handleTrimUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const preview = $('#videoPreview');
  const video = $('#previewVideo');
  if (video && preview) {
    video.src = URL.createObjectURL(file);
    preview.classList.add('show');
  }
  setStatus('');
}

async function trimVideo() {
  const fileInput = $('#trimFileInput');
  const start = ($('#trimStart') || {}).value || '00:00:00';
  const end = ($('#trimEnd') || {}).value;
  if (!fileInput || !fileInput.files[0]) return setStatus(T.statusUploadVideo || 'Please upload a video file', true);
  if (!end) return setStatus(T.statusSetEndTime || 'Please set end time', true);

  const btn = $('#trimBtn');
  if (btn) btn.disabled = true;
  setLoading(T.statusProcessing || 'Trimming video...');

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('start', start);
  formData.append('end', end);

  try {
    const res = await fetch('/api/trim', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) { setStatus(data.error || T.statusError || 'Trim failed', true); if (btn) btn.disabled = false; return; }

    const a = document.createElement('a');
    a.href = data.downloadUrl;
    a.download = data.filename || 'trimmed.mp4';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setStatus(T.statusDownloadStarted || 'Trim complete ✓');
  } catch { setStatus(T.statusConnectionError || 'Connection error', true); }
  if (btn) btn.disabled = false;
}

/* ========== Upload zone drag & drop ========== */
document.addEventListener('DOMContentLoaded', () => {
  $$('.upload-zone').forEach(zone => {
    const input = $('input[type="file"]', zone);
    zone.addEventListener('click', () => input?.click());
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.style.borderColor = 'var(--accent)'; });
    zone.addEventListener('dragleave', () => { zone.style.borderColor = ''; });
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.style.borderColor = '';
      if (input && e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
        input.dispatchEvent(new Event('change'));
      }
    });
  });
});

/* ========== Enter key on URL input ========== */
document.addEventListener('DOMContentLoaded', () => {
  const input = $('#urlInput');
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const fetchBtn = $('#fetchBtn');
        if (fetchBtn) fetchBtn.click();
      }
    });
  }
});
