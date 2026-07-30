// ギャラリーページのロジック(新郎新婦用)
// 画像は管理パスコードヘッダ付き fetch で取得し blob URL で表示する

const $ = (id) => document.getElementById(id);

const gate = $('gate');
const gateError = $('gate-error');
const adminPassInput = $('admin-pass');
const gateBtn = $('gate-btn');
const galleryMain = $('gallery-main');
const statsEl = $('stats');
const gridEl = $('grid');
const emptyEl = $('empty');
const lightbox = $('lightbox');
const lbClose = $('lb-close');
const lbContent = $('lb-content');
const lbCaption = $('lb-caption');

let adminPass = sessionStorage.getItem('adminPass') || '';

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function fmtDate(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- サムネイル取得の同時実行制御 ----
const fetchQueue = [];
let activeFetches = 0;
const MAX_FETCH = 4;

function enqueueFetch(task) {
  fetchQueue.push(task);
  pumpFetch();
}
function pumpFetch() {
  while (activeFetches < MAX_FETCH && fetchQueue.length > 0) {
    const task = fetchQueue.shift();
    activeFetches++;
    task().finally(() => {
      activeFetches--;
      pumpFetch();
    });
  }
}

async function fetchBlobUrl(key) {
  const res = await fetch('/api/photo/' + encodeURIComponent(key), {
    headers: { 'X-Admin-Passcode': adminPass },
  });
  if (!res.ok) throw new Error('取得に失敗しました');
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// ---- 認証 ----
async function tryLoad(pass) {
  const res = await fetch('/api/photos', { headers: { 'X-Admin-Passcode': pass } });
  if (res.status === 401) {
    throw Object.assign(new Error('パスコードが違います。'), { auth: true });
  }
  if (!res.ok) {
    let message = '読み込みに失敗しました。';
    try { message = (await res.json()).error || message; } catch (e) { /* noop */ }
    throw new Error(message);
  }
  return res.json();
}

gateBtn.addEventListener('click', unlock);
adminPassInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') unlock();
});

async function unlock() {
  const pass = adminPassInput.value.trim();
  if (!pass) return;
  gateBtn.disabled = true;
  gateError.hidden = true;
  try {
    const data = await tryLoad(pass);
    adminPass = pass;
    sessionStorage.setItem('adminPass', pass);
    show(data);
  } catch (err) {
    gateError.textContent = err.message;
    gateError.hidden = false;
  } finally {
    gateBtn.disabled = false;
  }
}

// sessionStorage にパスコードがあれば自動で開く
(async () => {
  if (!adminPass) return;
  try {
    const data = await tryLoad(adminPass);
    show(data);
  } catch (err) {
    sessionStorage.removeItem('adminPass');
    adminPass = '';
  }
})();

// ---- 一覧表示 ----
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const { key } = entry.target.dataset;
      const thumbEl = entry.target.querySelector('.thumb');
      enqueueFetch(async () => {
        try {
          const url = await fetchBlobUrl(key);
          const img = document.createElement('img');
          img.src = url;
          img.alt = '';
          thumbEl.innerHTML = '';
          thumbEl.appendChild(img);
        } catch (e) { /* 失敗時はプレースホルダのまま */ }
      });
    }
  },
  { rootMargin: '300px' }
);

function show(data) {
  gate.hidden = true;
  galleryMain.hidden = false;

  statsEl.textContent = `${data.count}件 / 合計 ${fmtSize(data.totalSize)}`;
  emptyEl.hidden = data.count > 0;
  gridEl.innerHTML = '';

  for (const photo of data.photos) {
    const isVideo = photo.contentType.startsWith('video/');
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.key = photo.key;

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (isVideo) {
      // 動画はサムネイル生成しない(タップで再生)
      thumb.innerHTML = '<span class="video-badge">&#9654;</span>';
    }

    const meta = document.createElement('div');
    meta.className = 'tile-meta';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = photo.uploaderName || '名前なし';
    const when = document.createElement('span');
    when.textContent = fmtDate(photo.uploaded);
    meta.append(who, when);

    tile.append(thumb, meta);
    tile.addEventListener('click', () => openLightbox(photo, isVideo));
    gridEl.appendChild(tile);

    if (!isVideo) observer.observe(tile);
  }
}

// ---- 原寸表示 ----
let lbUrl = null;

async function openLightbox(photo, isVideo) {
  lightbox.hidden = false;
  lbContent.innerHTML = '<span class="lb-loading">読み込み中…</span>';
  lbCaption.textContent =
    `${photo.uploaderName || '名前なし'} ・ ${fmtDate(photo.uploaded)} ・ ${fmtSize(photo.size)}`;
  try {
    const url = await fetchBlobUrl(photo.key);
    if (lightbox.hidden) {
      URL.revokeObjectURL(url);
      return;
    }
    lbUrl = url;
    lbContent.innerHTML = '';
    if (isVideo) {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      video.autoplay = true;
      lbContent.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      lbContent.appendChild(img);
    }
  } catch (e) {
    lbContent.innerHTML = '<span class="lb-loading">読み込みに失敗しました</span>';
  }
}

function closeLightbox() {
  lightbox.hidden = true;
  lbContent.innerHTML = '';
  if (lbUrl) {
    URL.revokeObjectURL(lbUrl);
    lbUrl = null;
  }
}

lbClose.addEventListener('click', closeLightbox);
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightbox.hidden) closeLightbox();
});
