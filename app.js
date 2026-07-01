/* ============================================================
   ChartScan — maimai DX internal-level scanner
   Data source: arcade-songs.zetaraku.dev (community maimai DB)
   ============================================================ */

const DATA_URL = 'https://dp4p6x0xfi5o9.cloudfront.net/maimai/data.json';
const DATA_ROOT = DATA_URL.replace(/\/data\.json$/, '');
const IMG_COVER_BASE = `${DATA_ROOT}/img/cover/`;
const IMG_COVER_M_BASE = `${DATA_ROOT}/img/cover-m/`;

// Local cache so a normal browsing session doesn't keep re-hitting the
// third-party data API — it's a shared free resource, not ours to hammer.
const CACHE_KEY = 'chartscan_maimai_data_v1';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// Fallback colors if the API doesn't supply one, keyed by difficulty order.
const FALLBACK_DIFF_COLORS = ['#4fc84f', '#e8a72c', '#f24a5a', '#a855f7', '#f4ecff', '#35e6de'];

const state = {
  data: null,          // raw fetched data
  songs: [],           // flattened songs w/ normalized fields
  difficultyMeta: {},  // code -> {name, color, order}
  typeMeta: {},         // code -> {name, abbr}
  stream: null,
  videoDevices: [],
  currentDeviceIndex: 0,
  ocrBusy: false,
  ocrWorker: null,      // reused across scans — avoids reloading the engine every time
  ocrLangs: null,        // which language packs actually loaded, for diagnostics
  currentSong: null,
  candidateList: [],    // songs shown in the currently open modal, for prev/next + filmstrip
  candidateIndex: -1,
  candidateLevelTokens: [],
  candidateDifficultyToken: null, // difficulty code read off the banner (e.g. "master"), for sheet highlighting
  candidateTypeToken: null,       // dx/std code read off the badge, for sheet highlighting
};

/* ---------------- DOM refs ---------------- */
const $ = (sel) => document.querySelector(sel);
const el = {
  dataStatus: $('#dataStatus'),
  dataStatusText: $('#dataStatusText'),
  refreshDataBtn: $('#refreshDataBtn'),
  viewfinder: $('#viewfinder'),
  video: $('#video'),
  capturedImg: $('#capturedImg'),
  vfPlaceholder: $('#vfPlaceholder'),
  scanProgress: $('#scanProgress'),
  startCamBtn: $('#startCamBtn'),
  captureBtn: $('#captureBtn'),
  switchCamBtn: $('#switchCamBtn'),
  uploadBtn: $('#uploadBtn'),
  fileInput: $('#fileInput'),
  rescanBtn: $('#rescanBtn'),
  ocrDebug: $('#ocrDebug'),
  ocrText: $('#ocrText'),
  searchInput: $('#searchInput'),
  autocomplete: $('#autocomplete'),
  emptySection: $('#emptySection'),
  modalOverlay: $('#modalOverlay'),
  modal: $('#modal'),
  modalContent: $('#modalContent'),
  modalClose: $('#modalClose'),
};

/* ---------------- Text utilities ---------------- */

// Strip everything but letters/numbers (unicode aware), lowercase.
function normalize(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

// Bigrams work well for Latin text (15-30+ char titles survive a stray OCR
// misread easily), but Japanese/Chinese titles are often only 3-6 characters
// total — a single misread character there can wipe out most of the
// available bigrams and tank the score even when OCR got the title mostly
// right. For CJK-heavy strings we compare single characters instead, which
// tolerates that much better.
function isCjkHeavy(str) {
  if (!str) return false;
  const cjk = str.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || [];
  return cjk.length / str.length > 0.4;
}

function grams(str, n) {
  if (str.length <= n) return str.length ? [str] : [];
  const out = [];
  for (let i = 0; i <= str.length - n; i++) out.push(str.slice(i, i + n));
  return out;
}

// Sørensen–Dice coefficient over character n-grams — cheap fuzzy match that
// tolerates OCR noise reasonably well. n adapts per pair: 1 (single
// characters) for CJK-heavy text, 2 (bigrams) otherwise.
function diceScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Short all-caps Latin titles (e.g. "HERA") only yield 2-3 bigrams, so a
  // single misread letter can wipe out every bigram and tank the score to
  // zero even though the word is nearly right. Stylized in-game logo fonts
  // misread individual letters far more often than they misread whole
  // longer words, so this case is common. Falling back to single-character
  // comparison for short strings — the same trick already used for CJK
  // text below — keeps one bad letter from failing the whole match.
  const shortPair = Math.min(a.length, b.length) <= 4;
  const n = (isCjkHeavy(a) || isCjkHeavy(b) || shortPair) ? 1 : 2;
  const A = grams(a, n);
  const B = grams(b, n);
  if (A.length === 0 || B.length === 0) return a.includes(b) || b.includes(a) ? 0.5 : 0;
  const counts = new Map();
  for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);
  let overlap = 0;
  for (const g of B) {
    const c = counts.get(g) || 0;
    if (c > 0) { overlap++; counts.set(g, c - 1); }
  }
  return (2 * overlap) / (A.length + B.length);
}

/* ---------------- Data loading (cached — see CACHE_TTL_MS) ---------------- */

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.data || !parsed.cachedAt) return null;
    return parsed;
  } catch (e) {
    return null; // storage disabled/unavailable — just skip caching
  }
}

function writeCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, cachedAt: Date.now() }));
  } catch (e) {
    /* storage full or unavailable — non-fatal, just means no caching */
  }
}

async function loadData(force = false) {
  const cached = readCache();
  const cacheAge = cached ? Date.now() - cached.cachedAt : Infinity;

  if (cached && !force && cacheAge < CACHE_TTL_MS) {
    applyData(cached.data, { fromCache: true, cachedAt: cached.cachedAt });
    if (el.refreshDataBtn) el.refreshDataBtn.classList.remove('hidden');
    return;
  }

  setDataStatus('loading', force ? 'Refreshing song data…' : 'Loading song data…');
  if (el.refreshDataBtn) el.refreshDataBtn.disabled = true;
  try {
    const res = await fetch(DATA_URL, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    writeCache(data);
    applyData(data, { fromCache: false });
  } catch (err) {
    console.error(err);
    if (cached) {
      // Network/CORS hiccup but we have something usable — fall back to it
      // rather than bothering the API again on every reload.
      applyData(cached.data, { fromCache: true, cachedAt: cached.cachedAt, staleFetchFailed: true });
    } else {
      setDataStatus('error', 'Could not load song data (network/CORS). Manual search & scanning are unavailable until this succeeds — try reloading.');
    }
  } finally {
    if (el.refreshDataBtn) {
      el.refreshDataBtn.disabled = false;
      el.refreshDataBtn.classList.remove('hidden');
    }
  }
}

function applyData(data, { fromCache, cachedAt, staleFetchFailed } = {}) {
  state.data = data;
  buildMeta(data);
  buildIndex(data);
  const when = cachedAt ? new Date(cachedAt).toLocaleString() : null;
  let text = `${state.songs.length} songs loaded`;
  if (fromCache && staleFetchFailed) text += ` · showing cache from ${when} (refresh failed)`;
  setDataStatus('ready', text);
}

function setDataStatus(kind, text) {
  el.dataStatus.classList.remove('ready', 'loading', 'error');
  el.dataStatus.classList.add(kind);
  el.dataStatusText.textContent = text;
}

function buildMeta(data) {
  (data.difficulties || []).forEach((d, i) => {
    state.difficultyMeta[d.difficulty] = {
      name: d.name || d.difficulty,
      color: d.color || FALLBACK_DIFF_COLORS[i % FALLBACK_DIFF_COLORS.length],
      order: i,
    };
  });
  (data.types || []).forEach((t) => {
    state.typeMeta[t.type] = { name: t.name || t.type, abbr: t.abbr || t.name || t.type };
  });
}

// The raw data.json only ships an `imageName` — the official site computes
// full cover URLs client-side from it. Our previous build never did this
// step, which is why covers silently failed to load; fixed here.
function resolveImgUrl(imageName, base) {
  if (!imageName) return null;
  try {
    return new URL(imageName, base).toString();
  } catch (e) {
    return null;
  }
}

function buildIndex(data) {
  state.songs = (data.songs || []).map((song) => {
    song.imageUrl = resolveImgUrl(song.imageName, IMG_COVER_BASE);
    song.imageUrlM = resolveImgUrl(song.imageName, IMG_COVER_M_BASE);
    return {
      song,
      nTitle: normalize(song.title),
      nArtist: normalize(song.artist),
    };
  });
}

/* ---------------- Manual search / autocomplete ---------------- */

function searchSongs(query, limit = 8) {
  const nq = normalize(query);
  if (!nq) return [];
  const scored = state.songs.map((entry) => {
    const titleContains = entry.nTitle.includes(nq) ? 1 : 0;
    const score = Math.max(
      diceScore(entry.nTitle, nq) + titleContains * 0.35,
      diceScore(entry.nArtist, nq) * 0.6,
    );
    return { song: entry.song, score };
  });
  return scored
    .filter((s) => s.score > 0.18)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

let acIndex = -1;
let acItems = [];

el.searchInput.addEventListener('input', () => {
  const q = el.searchInput.value.trim();
  if (!q) { closeAutocomplete(); return; }
  const results = searchSongs(q, 8);
  renderAutocomplete(results);
});

el.searchInput.addEventListener('keydown', (e) => {
  if (!el.autocomplete.classList.contains('open')) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = Math.min(acIndex + 1, acItems.length - 1); highlightAc(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); acIndex = Math.max(acIndex - 1, 0); highlightAc(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (acItems[acIndex]) acItems[acIndex].click(); }
  else if (e.key === 'Escape') { closeAutocomplete(); }
});

document.addEventListener('click', (e) => {
  if (!el.autocomplete.contains(e.target) && e.target !== el.searchInput) closeAutocomplete();
});

function closeAutocomplete() {
  el.autocomplete.classList.remove('open');
  el.autocomplete.innerHTML = '';
  acIndex = -1;
  acItems = [];
}

function highlightAc() {
  acItems.forEach((it, i) => it.classList.toggle('active', i === acIndex));
  if (acItems[acIndex]) acItems[acIndex].scrollIntoView({ block: 'nearest' });
}

function renderAutocomplete(results) {
  if (!results.length) { closeAutocomplete(); return; }
  el.autocomplete.innerHTML = '';
  acItems = results.map(({ song }, i) => {
    const item = document.createElement('div');
    item.className = 'ac-item';
    item.innerHTML = `
      <img ${imgAttrs(song)} width="36" height="36">
      <div class="meta">
        <div class="t">${escapeHtml(song.title || '(untitled)')}</div>
        <div class="a">${escapeHtml(song.artist || '')}</div>
      </div>`;
    item.addEventListener('click', () => {
      el.searchInput.value = song.title || '';
      closeAutocomplete();
      state.candidateList = results.map((r) => r.song);
      state.candidateLevelTokens = [];
      state.candidateDifficultyToken = null;
      state.candidateTypeToken = null;
      openCandidateAtIndex(i);
    });
    el.autocomplete.appendChild(item);
    return item;
  });
  el.autocomplete.classList.add('open');
}

/* ---------------- Camera ---------------- */

el.startCamBtn.addEventListener('click', startCamera);
el.switchCamBtn.addEventListener('click', switchCamera);
el.captureBtn.addEventListener('click', captureAndScan);
el.rescanBtn.addEventListener('click', resetScanner);
el.uploadBtn.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', handleFileUpload);

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    el.scanProgress.textContent = 'Camera unavailable — this page needs to be served over HTTPS (or http://localhost), not opened directly as a file.';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    state.stream = stream;
    el.video.srcObject = stream;
    el.vfPlaceholder.classList.add('hidden');
    el.video.classList.remove('hidden');
    el.capturedImg.classList.add('hidden');
    el.startCamBtn.classList.add('hidden');
    el.captureBtn.classList.remove('hidden');
    el.uploadBtn.classList.add('hidden');

    const devices = await navigator.mediaDevices.enumerateDevices();
    state.videoDevices = devices.filter((d) => d.kind === 'videoinput');
    if (state.videoDevices.length > 1) el.switchCamBtn.classList.remove('hidden');
  } catch (err) {
    console.error(err);
    el.scanProgress.textContent = `Couldn't access the camera (${err.message || err.name}). You can upload a photo instead.`;
  }
}

async function switchCamera() {
  if (!state.videoDevices.length) return;
  state.currentDeviceIndex = (state.currentDeviceIndex + 1) % state.videoDevices.length;
  const deviceId = state.videoDevices[state.currentDeviceIndex].deviceId;
  stopStream();
  const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } }, audio: false });
  state.stream = stream;
  el.video.srcObject = stream;
}

function stopStream() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
}

function grabVideoFrame() {
  const canvas = document.createElement('canvas');
  const size = 1400;
  const vw = el.video.videoWidth || size;
  const vh = el.video.videoHeight || size;
  const scale = size / Math.max(vw, vh);
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  canvas.getContext('2d').drawImage(el.video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Cheap Laplacian-variance sharpness estimate on a small grayscale sample.
// Handheld phone photos of arcade screens are very often motion-blurred —
// grabbing a quick burst and keeping the sharpest frame fixes that without
// asking the person to hold perfectly still.
function sharpnessScore(canvas) {
  const w = 220;
  const h = Math.round((canvas.height / canvas.width) * w) || 220;
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(canvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const lap = gray[idx - 1] + gray[idx + 1] + gray[idx - w] + gray[idx + w] - 4 * gray[idx];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean; // Laplacian variance ≈ sharpness
}

async function captureAndScan() {
  el.captureBtn.disabled = true;
  el.scanProgress.textContent = 'Capturing…';
  const frames = [];
  const shots = 4;
  for (let i = 0; i < shots; i++) {
    frames.push(grabVideoFrame());
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 70); });
  }
  el.captureBtn.disabled = false;

  let best = frames[0];
  let bestScore = -Infinity;
  for (const f of frames) {
    const s = sharpnessScore(f);
    if (s > bestScore) { bestScore = s; best = f; }
  }

  finishCapture(best);
}

function handleFileUpload(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const img = new Image();
  const reader = new FileReader();
  reader.onload = () => {
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const size = 1400;
      const scale = size / Math.max(img.width, img.height);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      finishCapture(canvas);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// A frame has been chosen (burst-picked or uploaded) — stop the camera and
// scan it immediately.
function finishCapture(canvas) {
  stopStream();
  el.video.classList.add('hidden');
  el.vfPlaceholder.classList.add('hidden');
  el.startCamBtn.classList.add('hidden');
  el.captureBtn.classList.add('hidden');
  el.switchCamBtn.classList.add('hidden');
  el.uploadBtn.classList.add('hidden');
  el.capturedImg.src = canvas.toDataURL('image/jpeg', 0.92);
  el.capturedImg.classList.remove('hidden');
  el.rescanBtn.classList.remove('hidden');
  runOcr(canvas);
}

// Grayscale + local-contrast pass. Photographed arcade screens are often
// unevenly lit (glare, reflections), so instead of one global stretch we
// blur a copy to approximate the local lighting level and subtract it out —
// this separates text from background far better under uneven light. Falls
// back to a simple global stretch if the blur step is unsupported. Also
// gently upscales small captures, since OCR is much more reliable on larger
// glyphs.
function preprocessForOcr(sourceCanvas) {
  const targetMax = 2000; // CJK glyphs are denser than Latin text and need more pixels to stay legible
  const srcMax = Math.max(sourceCanvas.width, sourceCanvas.height);
  const upscale = srcMax < targetMax ? Math.min(2.2, targetMax / srcMax) : 1;

  const out = document.createElement('canvas');
  out.width = Math.round(sourceCanvas.width * upscale);
  out.height = Math.round(sourceCanvas.height * upscale);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, out.width, out.height);

  const imgData = ctx.getImageData(0, 0, out.width, out.height);
  const d = imgData.data;
  const n = d.length / 4;
  const gray = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = gray[p];
  }
  ctx.putImageData(imgData, 0, 0); // plain grayscale, used as the blur source below

  let usedLocalContrast = false;
  try {
    const blurCanvas = document.createElement('canvas');
    blurCanvas.width = out.width;
    blurCanvas.height = out.height;
    const bctx = blurCanvas.getContext('2d');
    // Radius scales gently with image size but is capped low — CJK glyph
    // strokes are much finer than Latin digits, and a large blur radius
    // (the previous version scaled up to ~50-80px on a typical capture)
    // smears them away before OCR ever sees them, even though it barely
    // affects bold simple numerals. A smaller radius still evens out slow
    // glare gradients without destroying fine character detail.
    const radius = Math.max(8, Math.min(22, Math.round(Math.min(out.width, out.height) * 0.018)));
    bctx.filter = `blur(${radius}px)`;
    bctx.drawImage(out, 0, 0);
    const blurData = bctx.getImageData(0, 0, out.width, out.height).data;

    // Smell-test that the blur actually did something — some very old
    // browsers silently ignore ctx.filter.
    let blurDiffers = false;
    for (let i = 0; i < d.length; i += 4001) {
      if (Math.abs(blurData[i] - d[i]) > 3) { blurDiffers = true; break; }
    }

    if (blurDiffers) {
      const gain = 1.4;
      const tmp = new Float32Array(n);
      let lmin = 255;
      let lmax = 0;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        let v = 128 + (gray[p] - blurData[i]) * gain;
        v = Math.max(0, Math.min(255, v));
        tmp[p] = v;
        if (v < lmin) lmin = v;
        if (v > lmax) lmax = v;
      }
      const lrange = Math.max(1, lmax - lmin);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        let v = ((tmp[p] - lmin) / lrange) * 255;
        v = 255 * (v / 255) ** 0.9;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      usedLocalContrast = true;
    }
  } catch (err) {
    usedLocalContrast = false;
  }

  if (!usedLocalContrast) {
    let min = 255;
    let max = 0;
    for (let p = 0; p < n; p++) { if (gray[p] < min) min = gray[p]; if (gray[p] > max) max = gray[p]; }
    const range = Math.max(1, max - min);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      let v = ((gray[p] - min) / range) * 255;
      v = 255 * (v / 255) ** 0.85;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return out;
}

function resetScanner() {
  el.capturedImg.classList.add('hidden');
  el.video.classList.add('hidden');
  el.vfPlaceholder.classList.remove('hidden');
  el.viewfinder.classList.remove('matched', 'scanning');
  el.viewfinder.style.removeProperty('--diff-color');
  el.startCamBtn.classList.remove('hidden');
  el.captureBtn.classList.add('hidden');
  el.switchCamBtn.classList.add('hidden');
  el.rescanBtn.classList.add('hidden');
  el.uploadBtn.classList.remove('hidden');
  el.scanProgress.textContent = '';
  el.ocrDebug.classList.add('hidden');
  el.fileInput.value = '';
  stopStream();
}

/* ---------------- OCR ---------------- */

// The worker is created once and reused for every scan in the session —
// loading the engine + language data is the slow part, so re-creating it
// per scan would be wasteful and slow. Torn down on page unload.
// maimai's international dataset is mostly Japanese-titled, with some
// English/Korean and occasional Chinese-origin characters, so we ask for
// all three scripts. If the full set fails to load (flaky connection, a
// blocked CDN, etc.) we retry with a smaller set instead of just silently
// failing — and say so, rather than leaving it as a generic "OCR failed".
const OCR_LANG_SETS = [
  ['eng', 'jpn', 'chi_sim'],
  ['eng', 'jpn'],
  ['eng'],
];

async function getOcrWorker() {
  if (state.ocrWorker) return state.ocrWorker;
  if (typeof Tesseract === 'undefined') throw new Error('Tesseract.js failed to load');
  const oem = (Tesseract.OEM && Tesseract.OEM.LSTM_ONLY) ?? 1;

  let lastErr = null;
  for (const langs of OCR_LANG_SETS) {
    try {
      el.scanProgress.textContent = `Loading OCR engine (${langs.join('+')})…`;
      // eslint-disable-next-line no-await-in-loop
      const worker = await Tesseract.createWorker(langs, oem, {
        logger: (m) => {
          if (m.status && typeof m.progress === 'number') {
            el.scanProgress.textContent = `${prettyOcrStatus(m.status)} ${Math.round(m.progress * 100)}%`;
          }
        },
      });
      state.ocrWorker = worker;
      state.ocrLangs = langs;
      if (langs.length < OCR_LANG_SETS[0].length) {
        console.warn(`ChartScan: OCR fell back to ${langs.join('+')} — some language packs failed to load, likely a network/CDN issue.`);
      }
      return worker;
    } catch (err) {
      console.error(`ChartScan: failed to load OCR worker with langs [${langs.join(',')}]`, err);
      lastErr = err;
    }
  }
  throw lastErr || new Error('Could not initialize the OCR engine with any language set');
}

async function runOcrPass(worker, canvas, psm) {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await worker.recognize(canvas);
  const confidences = (data.words || [])
    .map((w) => w.confidence)
    .filter((c) => typeof c === 'number');
  const meanConfidence = confidences.length
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : (data.confidence || 0);
  return { text: data.text || '', meanConfidence };
}

async function runOcr(canvas) {
  if (state.ocrBusy) return; // guard against double-fire
  state.ocrBusy = true;
  el.rescanBtn.disabled = true;
  el.viewfinder.classList.add('scanning');
  el.scanProgress.textContent = 'Enhancing image…';

  try {
    const ocrCanvas = preprocessForOcr(canvas);
    const worker = await getOcrWorker();

    const psmSparse = (Tesseract.PSM && Tesseract.PSM.SPARSE_TEXT) ?? '11';
    const psmBlock = (Tesseract.PSM && Tesseract.PSM.SINGLE_BLOCK) ?? '6';
    const psmLine = (Tesseract.PSM && Tesseract.PSM.SINGLE_LINE) ?? '7';

    // Three passes with different page-segmentation assumptions: scattered
    // UI text, a single clean block, and a single line. The single-line
    // pass in particular tends to rescue short, large, stylized English
    // titles (arcade logo-style fonts) that the other two modes often
    // misread — Tesseract's segmentation step second-guesses itself less
    // when it's told there's exactly one line to read. All three passes'
    // text and level digits get merged rather than picking just one winner,
    // since confidence doesn't reliably predict which pass got a given word
    // right.
    el.scanProgress.textContent = 'Reading text (pass 1/3)…';
    const pass1 = await runOcrPass(worker, ocrCanvas, psmSparse);
    el.scanProgress.textContent = 'Reading text (pass 2/3)…';
    const pass2 = await runOcrPass(worker, ocrCanvas, psmBlock);
    el.scanProgress.textContent = 'Reading text (pass 3/3)…';
    const pass3 = await runOcrPass(worker, ocrCanvas, psmLine);

    const passes = [pass1, pass2, pass3];
    const best = passes.reduce((a, b) => (b.meanConfidence > a.meanConfidence ? b : a));
    el.ocrText.textContent = best.text.trim() || '(no text recognized)';
    el.ocrDebug.classList.remove('hidden');

    if (!state.songs.length) {
      el.scanProgress.textContent = 'Song data isn\u2019t loaded yet — try again in a moment.';
      return;
    }
    el.scanProgress.textContent = 'Matching against song database…';

    const levelTokens = [...new Set(passes.flatMap((p) => extractLevelTokens(p.text)))];
    const difficultyToken = passes.map((p) => extractDifficultyToken(p.text)).find(Boolean) || null;
    const typeToken = passes.map((p) => extractTypeToken(p.text)).find(Boolean) || null;
    const bpmToken = passes.map((p) => extractBpmToken(p.text)).find((v) => v != null) ?? null;
    // Match against all three passes' text, not just whichever the engine
    // was more confident about — short stylized titles often get read
    // correctly in one page-segmentation mode and mangled in another.
    // Combining gives every candidate word a chance to be picked up.
    const combinedText = passes.map((p) => p.text).join('\n');
    const candidates = rankSongsByText(combinedText, { levelTokens, difficultyToken, typeToken, bpmToken }, 6);

    if (!candidates.length) {
      el.scanProgress.textContent = 'No confident match found — try manual search below, or retake the photo.';
    } else {
      // Pop the best match straight open — the popup itself has prev/next
      // and a cover filmstrip, so correcting a wrong guess is one tap away
      // rather than needing a confirmation step first.
      el.scanProgress.textContent = candidates.length === 1
        ? `Matched “${candidates[0].song.title}”.`
        : `Matched “${candidates[0].song.title}” — ${candidates.length - 1} other possible match${candidates.length > 2 ? 'es' : ''} available in the popup.`;
      state.candidateList = candidates.map((c) => c.song);
      state.candidateLevelTokens = levelTokens;
      state.candidateDifficultyToken = difficultyToken;
      state.candidateTypeToken = typeToken;
      openCandidateAtIndex(0);
    }
  } catch (err) {
    console.error(err);
    el.scanProgress.textContent = 'OCR failed. Try again, or search manually below.';
  } finally {
    state.ocrBusy = false;
    el.rescanBtn.disabled = false;
    el.viewfinder.classList.remove('scanning');
  }
}

function prettyOcrStatus(status) {
  const map = {
    'loading tesseract core': 'Loading engine',
    'initializing tesseract': 'Initializing',
    'loading language traineddata': 'Loading language data',
    'initializing api': 'Preparing',
    'recognizing text': 'Recognizing text',
  };
  return map[status] || status;
}

// maimai levels: 1–15, optionally with a trailing "+".
function extractLevelTokens(text) {
  const matches = text.match(/\b(1[0-5]|[1-9])\+?\b/g) || [];
  return [...new Set(matches)];
}

// The difficulty banner ("BASIC"/"ADVANCED"/"EXPERT"/"MASTER"/"Re:MASTER")
// is shown in English even on the Japanese client, so it can be matched
// directly against the current dataset's own difficulty names rather than
// a hardcoded/localized list. Longest name first so "Re:MASTER" is picked
// over the "MASTER" substring it contains.
function extractDifficultyToken(text) {
  const normalizedText = normalize(text);
  if (!normalizedText) return null;
  const candidates = Object.entries(state.difficultyMeta)
    .map(([code, meta]) => ({ code, key: normalize(meta.name || code) }))
    .filter((c) => c.key.length >= 3)
    .sort((a, b) => b.key.length - a.key.length);
  const hit = candidates.find((c) => normalizedText.includes(c.key));
  return hit ? hit.code : null;
}

// The DX/Standard badge (top-left corner — "でらっくす"/DX vs
// "スタンダード"/STD) disambiguates songs that have both a DX and a
// Standard chart set at the same displayed level.
function extractTypeToken(text) {
  const normalizedText = normalize(text);
  if (!normalizedText) return null;
  const typeCandidates = Object.entries(state.typeMeta).map(([code, meta]) => ({
    code,
    keys: [normalize(meta.name), normalize(meta.abbr)].filter((k) => k && k.length >= 2),
  }));
  const datasetHit = typeCandidates.find((t) => t.keys.some((k) => normalizedText.includes(k)));
  if (datasetHit) return datasetHit.code;
  // Fall back to the badge's EN/JP wording, mapped onto whichever dataset
  // code looks like DX / Standard — the dataset's own name/abbr sometimes
  // won't literally contain the on-screen badge text.
  const dxCode = typeCandidates.find((t) => /dx/i.test(t.code))?.code;
  const stdCode = typeCandidates.find((t) => /std|standard/i.test(t.code))?.code;
  if (dxCode && (normalizedText.includes('でらっくす') || normalizedText.includes('deluxe'))) return dxCode;
  if (stdCode && (normalizedText.includes('スタンダード') || normalizedText.includes('standard'))) return stdCode;
  return null;
}

// BPM is printed plainly on the results/select screen and is a very
// specific, largely collision-free number — a strong independent check
// against the title/artist text match.
function extractBpmToken(text) {
  const m = text.match(/bpm\D{0,4}(\d{2,4})/i);
  return m ? parseInt(m[1], 10) : null;
}

function rankSongsByText(text, tokens, limit) {
  const rawLines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const lines = rawLines.map((l) => normalize(l)).filter((l) => l.length >= 2);
  // Individual words too — OCR often nails one part of a long/compound title
  // even when the full line is noisy (line breaks in the wrong place, stray
  // UI glyphs mixed in, etc).
  const words = rawLines
    .flatMap((l) => l.split(/[\s/|·・:,()[\]]+/))
    .map((w) => normalize(w))
    .filter((w) => w.length >= 3);
  const fullBlob = normalize(text);
  if (!lines.length && !words.length) return [];

  const { levelTokens = [], difficultyToken = null, typeToken = null, bpmToken = null } = tokens || {};
  const levelSet = new Set(levelTokens.map((t) => t.toLowerCase()));

  const scored = state.songs.map((entry) => {
    let best = 0;
    for (const line of lines) {
      best = Math.max(best, diceScore(entry.nTitle, line));
      if (entry.nArtist) best = Math.max(best, diceScore(entry.nArtist, line) * 0.7);
    }
    for (const word of words) {
      best = Math.max(best, diceScore(entry.nTitle, word) * 0.75);
    }
    if (entry.nTitle.length >= 3 && fullBlob.includes(entry.nTitle)) best = Math.max(best, 0.92);

    // Cross-validate against everything else visible on screen — each of
    // these is an independent signal, so a title match that's also backed
    // by the right level, difficulty banner, DX/Standard badge and/or BPM
    // is far more trustworthy than title text alone, and this is what lets
    // us tell apart songs that otherwise look identical from OCR text.
    if (best > 0.2) {
      const sheets = entry.song.sheets || [];
      let bonus = 0;
      const levelMatchSheet = levelSet.size ? sheets.find((s) => levelSet.has((s.level || '').toLowerCase())) : null;
      if (levelMatchSheet) {
        bonus += 0.10;
        if (difficultyToken && levelMatchSheet.difficulty === difficultyToken) bonus += 0.08;
      }
      if (typeToken && sheets.some((s) => s.type === typeToken)) bonus += 0.05;
      if (bpmToken != null && entry.song.bpm != null && Math.abs(entry.song.bpm - bpmToken) <= 1) bonus += 0.12;
      best = Math.min(1, best + bonus);
    }

    return { song: entry.song, score: best };
  });

  return scored
    .filter((s) => s.score > 0.28)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/* ---------------- Rendering: song + sheets ---------------- */

// Jumps the open (or about-to-open) modal to a specific song within the
// current candidate list — used by prev/next buttons, the cover filmstrip,
// and arrow-key navigation.
function openCandidateAtIndex(index) {
  const list = state.candidateList;
  if (!list.length) return;
  const clamped = ((index % list.length) + list.length) % list.length;
  state.candidateIndex = clamped;
  selectSong(list[clamped], {
    levelTokens: state.candidateLevelTokens,
    difficultyToken: state.candidateDifficultyToken,
    typeToken: state.candidateTypeToken,
  });
}

// Picks which sheet the scan is most likely looking at. Level alone can be
// ambiguous (a song can repeat the same displayed level across difficulties,
// or across its DX/Standard charts) — the difficulty banner and DX/Standard
// badge, when readable, narrow a level match down to the exact chart.
function pickHighlightSheet(sheets, { levelTokens = [], difficultyToken, typeToken } = {}) {
  const levelSet = new Set(levelTokens.map((t) => t.toLowerCase()));
  if (!levelSet.size) return null;
  const matches = sheets.filter((s) => levelSet.has((s.level || '').toLowerCase()));
  if (!matches.length) return null;
  const specificity = (s) => (difficultyToken && s.difficulty === difficultyToken ? 2 : 0)
    + (typeToken && s.type === typeToken ? 1 : 0);
  return matches.reduce((a, b) => (specificity(b) > specificity(a) ? b : a));
}

function selectSong(song, opts = {}) {
  state.currentSong = song;
  el.emptySection.classList.add('hidden');

  const levelTokens = opts.levelTokens || [];
  const sheets = [...(song.sheets || [])].sort((a, b) => {
    const oa = state.difficultyMeta[a.difficulty]?.order ?? 99;
    const ob = state.difficultyMeta[b.difficulty]?.order ?? 99;
    return oa - ob;
  });

  const highlightSheet = pickHighlightSheet(sheets, {
    levelTokens,
    difficultyToken: opts.difficultyToken,
    typeToken: opts.typeToken,
  });
  const hasMultiple = state.candidateList.length > 1;

  // Some songs have both a DX and a Standard chart set (different note
  // patterns/levels per type). Read the available type codes straight from
  // the API's own `types` list rather than hardcoding "dx"/"std".
  const availableTypes = [...new Set(sheets.map((s) => s.type).filter(Boolean))];
  const hasTypeChoice = availableTypes.length > 1;
  let activeType = highlightSheet?.type
    || availableTypes.find((t) => /dx/i.test(t))
    || availableTypes[0];

  const wrap = document.createElement('div');

  if (hasMultiple) {
    const nav = document.createElement('div');
    nav.className = 'modal-nav';
    nav.innerHTML = `
      <button type="button" class="nav-btn nav-prev" aria-label="Previous match">‹</button>
      <span class="modal-nav-count">${state.candidateIndex + 1} / ${state.candidateList.length}</span>
      <button type="button" class="nav-btn nav-next" aria-label="Next match">›</button>
    `;
    nav.querySelector('.nav-prev').addEventListener('click', () => openCandidateAtIndex(state.candidateIndex - 1));
    nav.querySelector('.nav-next').addEventListener('click', () => openCandidateAtIndex(state.candidateIndex + 1));
    wrap.appendChild(nav);
  }

  const card = document.createElement('div');
  card.className = 'song-card';
  const ytQuery = encodeURIComponent(`${song.title || ''} ${song.artist || ''}`.trim());
  card.innerHTML = `
    <img class="cover" ${imgAttrs(song)}>
    <div class="info">
      <h2 id="modalTitle">${escapeHtml(song.title || '(untitled)')}</h2>
      <div class="artist">${escapeHtml(song.artist || 'Unknown artist')}</div>
      <div class="tags">
        ${song.bpm ? `<span class="tag">BPM ${escapeHtml(String(song.bpm))}</span>` : ''}
        ${song.version ? `<span class="tag">${escapeHtml(song.version)}</span>` : ''}
        ${song.category ? `<span class="tag">${escapeHtml(song.category)}</span>` : ''}
      </div>
      <a class="yt-btn" href="https://www.youtube.com/results?search_query=${ytQuery}" target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/></svg>
        Search on YouTube
      </a>
    </div>`;
  wrap.appendChild(card);

  let typeToggle = null;
  if (hasTypeChoice) {
    typeToggle = document.createElement('div');
    typeToggle.className = 'type-toggle';
    availableTypes.forEach((t) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.type = t;
      btn.className = t === activeType ? 'type-btn active' : 'type-btn';
      btn.textContent = state.typeMeta[t]?.abbr || state.typeMeta[t]?.name || t.toUpperCase();
      typeToggle.appendChild(btn);
    });
    wrap.appendChild(typeToggle);
  }

  const grid = document.createElement('div');
  grid.className = 'sheet-grid';
  wrap.appendChild(grid);

  function renderGrid() {
    grid.innerHTML = '';
    const visibleSheets = hasTypeChoice ? sheets.filter((s) => s.type === activeType) : sheets;

    visibleSheets.forEach((sheet) => {
      const meta = state.difficultyMeta[sheet.difficulty] || {};
      const color = meta.color || '#35e6de';
      const typeAbbr = state.typeMeta[sheet.type]?.abbr;

      const sc = document.createElement('div');
      sc.className = 'sheet-card';
      sc.style.setProperty('--dc', color);
      if (sheet === highlightSheet) sc.classList.add('highlight');

      const internalText = sheet.internalLevel != null ? sheet.internalLevel : (sheet.internalLevelValue != null ? sheet.internalLevelValue.toFixed(1) : null);
      const noteCounts = sheet.noteCounts || null;

      sc.innerHTML = `
        <div class="diff-name">${escapeHtml(meta.name || sheet.difficulty || '')}${!hasTypeChoice && typeAbbr ? ` · ${escapeHtml(typeAbbr)}` : ''}</div>
        <div class="level-internal${internalText != null ? '' : ' no-data'}">${escapeHtml(internalText != null ? String(internalText) : (sheet.level || '?'))}</div>
        <div class="reveal-row">
          ${internalText != null ? `<span class="arrow">displayed&nbsp;→</span><span class="displayed">${escapeHtml(sheet.level || '?')}</span>` : '<span class="arrow">no internal level data</span>'}
        </div>
        <div class="sub">
          <span>${sheet.noteDesigner ? escapeHtml(sheet.noteDesigner) : ''}</span>
          <span>${noteCounts && noteCounts.total != null ? noteCounts.total + ' notes' : ''}</span>
        </div>
        ${noteCounts ? `<div class="notecounts">
          ${['tap','hold','slide','touch','break','total'].filter((k) => noteCounts[k] != null).map((k) => `<div><span>${k}</span>${noteCounts[k]}</div>`).join('')}
        </div>` : ''}
      `;

      sc.addEventListener('click', () => {
        sc.classList.toggle('expanded');
      });

      grid.appendChild(sc);
    });

    // Staggered flip-reveal animation for the internal levels.
    const cards = grid.querySelectorAll('.sheet-card');
    cards.forEach((c, i) => {
      setTimeout(() => c.classList.add('revealed'), 160 + i * 90);
    });

    // Ring color follows whichever chart type is currently shown.
    const ringSheet = (highlightSheet && highlightSheet.type === activeType && highlightSheet) || visibleSheets[0];
    const ringColor = ringSheet && state.difficultyMeta[ringSheet.difficulty]?.color;
    if (ringColor) el.viewfinder.style.setProperty('--diff-color', ringColor);
  }

  if (typeToggle) {
    typeToggle.querySelectorAll('.type-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.type === activeType) return;
        activeType = btn.dataset.type;
        typeToggle.querySelectorAll('.type-btn').forEach((b) => b.classList.toggle('active', b === btn));
        renderGrid();
      });
    });
  }

  renderGrid();

  if (hasMultiple) {
    const strip = document.createElement('div');
    strip.className = 'modal-filmstrip';
    state.candidateList.forEach((s, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = i === state.candidateIndex ? 'filmstrip-item active' : 'filmstrip-item';
      btn.title = s.title || '';
      btn.innerHTML = `<img ${imgAttrs(s)}>`;
      btn.addEventListener('click', () => openCandidateAtIndex(i));
      strip.appendChild(btn);
    });
    wrap.appendChild(strip);
  }

  openModal(wrap, song.title);
  el.viewfinder.classList.add('matched');
}

/* ---------------- Cover image fallback ---------------- */
// Tries the full-size cover, then the medium cover, then a generated
// placeholder — so a single broken/missing image never leaves a blank box.
window.handleImgError = function handleImgError(img) {
  const fb = img.getAttribute('data-fallback');
  if (fb) {
    img.setAttribute('data-fallback', '');
    img.src = fb;
    return;
  }
  img.onerror = null;
  img.src = placeholderDataUri(img.getAttribute('data-title') || '');
};

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
  return h;
}

function placeholderDataUri(text) {
  const clean = (text || '?').trim();
  const initial = clean.charAt(0).toUpperCase() || '?';
  const hue = Math.abs(hashCode(clean)) % 360;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>`
    + `<rect width='100%' height='100%' fill='hsl(${hue},40%,16%)'/>`
    + `<text x='50%' y='55%' font-family='Inter,sans-serif' font-size='60' font-weight='700' `
    + `fill='hsl(${hue},60%,72%)' text-anchor='middle' dominant-baseline='middle'>${initial}</text>`
    + `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// Builds the attributes for an <img> tag with a two-step fallback chain.
function imgAttrs(song) {
  const full = song.imageUrl || '';
  const medium = song.imageUrlM || '';
  const primary = full || medium;
  const fallback = full && medium && full !== medium ? medium : '';
  const title = escapeHtml(song.title || '');
  return `src="${primary}" data-fallback="${fallback}" data-title="${title}" onerror="handleImgError(this)" loading="lazy" alt=""`;
}

/* ---------------- Modal popup ---------------- */

function openModal(contentEl) {
  el.modalContent.innerHTML = '';
  el.modalContent.appendChild(contentEl);
  el.modalOverlay.classList.remove('hidden');
  requestAnimationFrame(() => el.modalOverlay.classList.add('open'));
  document.body.style.overflow = 'hidden';
  el.modalClose.focus({ preventScroll: true });
}

function closeModal() {
  el.modalOverlay.classList.remove('open');
  document.body.style.overflow = '';
  setTimeout(() => {
    if (!el.modalOverlay.classList.contains('open')) {
      el.modalOverlay.classList.add('hidden');
      el.modalContent.innerHTML = '';
    }
  }, 200);
}

el.modalClose.addEventListener('click', closeModal);
el.modalOverlay.addEventListener('click', (e) => {
  if (e.target === el.modalOverlay) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (!el.modalOverlay.classList.contains('open')) return;
  if (e.key === 'Escape') { closeModal(); return; }
  if (state.candidateList.length > 1) {
    if (e.key === 'ArrowRight') openCandidateAtIndex(state.candidateIndex + 1);
    else if (e.key === 'ArrowLeft') openCandidateAtIndex(state.candidateIndex - 1);
  }
});



/* ---------------- Utils ---------------- */

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------------- Init ---------------- */

if (el.refreshDataBtn) {
  el.refreshDataBtn.addEventListener('click', () => loadData(true));
}

loadData();
window.addEventListener('beforeunload', () => {
  stopStream();
  if (state.ocrWorker) state.ocrWorker.terminate();
});
