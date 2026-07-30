// ライブムービーページ(会場スクリーン投影用)
// 5秒ごとに新着をポーリングし、写真を右から左へ流す。
// 新着写真は「届きました!」の演出後にムービーへ合流する。

const POLL_MS = 5000; // 新着確認の間隔
const SPAWN_MS = 2200; // 写真を流し始める間隔
const MAX_CARDS = 14; // 同時に流れる最大枚数
const CACHE_MAX = 40; // blob URLキャッシュ上限

// 完全な重なりを防ぐためのレーン設定。
// 同一レーン内は速度をほぼ揃え(±8%)、レーンを巡回して配置することで
// 追い抜きによる完全重なりを避ける(少しの重なりは許容)。
const LANES = [
  { top: 4, height: 30, duration: 30000 },
  { top: 34, height: 30, duration: 25000 },
  { top: 64, height: 30, duration: 35000 },
];

const $ = (id) => document.getElementById(id);
const gate = $('gate');
const gateError = $('gate-error');
const adminPassInput = $('admin-pass');
const gateBtn = $('gate-btn');
const stage = $('stage');
const waiting = $('waiting');
const cardsEl = $('cards');
const toast = $('toast');
const toastText = $('toast-text');
const newCardEl = $('new-card');
const fsBtn = $('fs-btn');

let adminPass = sessionStorage.getItem('adminPass') || '';
let pool = []; // ムービーで流す写真(画像のみ)
let queue = []; // シャッフル済みの再生キュー
const knownKeys = new Set();
let activeCards = 0;
let started = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---- blob URLキャッシュ(参照カウント付き) ----
const cache = new Map(); // key -> { url, refs }

async function acquire(key) {
  const hit = cache.get(key);
  if (hit) {
    hit.refs++;
    return hit.url;
  }
  const res = await fetch('./api/photo/' + encodeURIComponent(key), {
    headers: { 'X-Admin-Passcode': adminPass },
  });
  if (!res.ok) throw new Error('fetch failed');
  const url = URL.createObjectURL(await res.blob());
  cache.set(key, { url, refs: 1 });
  pruneCache();
  return url;
}

function release(key) {
  const e = cache.get(key);
  if (e && e.refs > 0) e.refs--;
}

function pruneCache() {
  if (cache.size <= CACHE_MAX) return;
  for (const [k, e] of cache) {
    if (cache.size <= CACHE_MAX) break;
    if (e.refs <= 0) {
      URL.revokeObjectURL(e.url);
      cache.delete(k);
    }
  }
}

// ---- 認証 ----
async function fetchPhotos(pass) {
  const res = await fetch('./api/photos', { headers: { 'X-Admin-Passcode': pass } });
  if (res.status === 401) throw Object.assign(new Error('パスコードが違います。'), { auth: true });
  if (!res.ok) throw new Error('読み込みに失敗しました。');
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
    const data = await fetchPhotos(pass);
    adminPass = pass;
    sessionStorage.setItem('adminPass', pass);
    start(data);
  } catch (err) {
    gateError.textContent = err.message;
    gateError.hidden = false;
  } finally {
    gateBtn.disabled = false;
  }
}

(async () => {
  if (!adminPass) return;
  try {
    const data = await fetchPhotos(adminPass);
    start(data);
  } catch (err) {
    sessionStorage.removeItem('adminPass');
    adminPass = '';
  }
})();

// ---- 開始 ----
function start(data) {
  if (started) return;
  started = true;
  gate.hidden = true;
  stage.hidden = false;
  makeSparkles();

  // 既存の写真は演出なしでプールに入れる
  for (const p of data.photos) {
    knownKeys.add(p.key);
    if (p.contentType.startsWith('image/')) pool.push(p);
  }
  updateWaiting();

  setInterval(spawnTick, SPAWN_MS);
  setInterval(poll, POLL_MS);
  spawnTick();
}

function updateWaiting() {
  waiting.hidden = pool.length > 0;
}

function nextPhoto() {
  if (pool.length === 0) return null;
  if (queue.length === 0) queue = shuffle(pool.slice());
  return queue.pop();
}

// ---- 写真を流す ----
let laneOrder = [];
let laneIdx = 0;

function nextLane() {
  if (laneIdx >= laneOrder.length) {
    laneOrder = shuffle(LANES.map((_, i) => i));
    laneIdx = 0;
  }
  return LANES[laneOrder[laneIdx++]];
}

function spawnTick() {
  if (document.hidden) return;
  if (activeCards >= MAX_CARDS) return;
  const photo = nextPhoto();
  if (photo) spawnCard(photo);
}

async function spawnCard(photo) {
  activeCards++;
  try {
    const url = await acquire(photo.key);
    const card = document.createElement('div');
    card.className = 'float-card';
    const img = document.createElement('img');
    img.alt = '';
    const name = document.createElement('div');
    name.className = 'float-name';
    name.textContent = photo.uploaderName || '';

    card.append(img, name);

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });

    const lane = nextLane();
    const h = 20 + Math.random() * Math.max(2, lane.height - 22); // 高さ 20〜28vh
    card.style.height = h + 'vh';
    card.style.top = lane.top + Math.random() * (lane.height - h) + 'vh';
    cardsEl.appendChild(card);

    const rot = Math.random() * 8 - 4;
    const dur = lane.duration * (0.92 + Math.random() * 0.16); // レーン基準速度 ±8%
    const anim = card.animate(
      [
        { transform: `translateX(100vw) rotate(${rot}deg)` },
        { transform: `translateX(${-(card.offsetWidth + 120)}px) rotate(${rot}deg)` },
      ],
      { duration: dur, easing: 'linear' }
    );
    anim.onfinish = () => {
      card.remove();
      release(photo.key);
      activeCards--;
    };
  } catch (e) {
    release(photo.key);
    activeCards--;
  }
}

// ---- 背景のキラキラ ----
function makeSparkles() {
  const wrap = document.createElement('div');
  wrap.className = 'sparkles';
  for (let i = 0; i < 34; i++) {
    const s = document.createElement('span');
    const star = Math.random() < 0.3;
    s.className = star ? 'sparkle sparkle-star' : 'sparkle';
    if (star) s.textContent = '✦';
    s.style.left = Math.random() * 100 + 'vw';
    s.style.top = Math.random() * 100 + 'vh';
    const size = 5 + Math.random() * 11;
    if (star) {
      s.style.fontSize = size + 4 + 'px';
    } else {
      s.style.width = size + 'px';
      s.style.height = size + 'px';
    }
    s.style.animationDuration = 2.5 + Math.random() * 4 + 's';
    s.style.animationDelay = Math.random() * 5 + 's';
    wrap.appendChild(s);
  }
  stage.prepend(wrap);
}

// ---- 新着の検知と演出 ----
let announceChain = Promise.resolve();

async function poll() {
  if (!started) return;
  try {
    const data = await fetchPhotos(adminPass);
    // 古い順に処理して到着順どおりに演出する
    for (const p of data.photos.slice().reverse()) {
      if (knownKeys.has(p.key)) continue;
      knownKeys.add(p.key);
      if (!p.contentType.startsWith('image/')) continue; // 動画はムービー対象外
      announceChain = announceChain.then(() => announce(p)).catch(() => {});
    }
  } catch (e) {
    // 一時的な失敗は次回のポーリングに任せる
  }
}

async function announce(photo) {
  const url = await acquire(photo.key);

  toastText.textContent = photo.uploaderName
    ? `${photo.uploaderName}さんから写真が届きました!`
    : 'たった今、写真が届きました!';
  toast.hidden = false;
  toast.classList.add('show');

  newCardEl.innerHTML = '';
  const img = document.createElement('img');
  img.alt = '';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  }).catch(() => {});
  newCardEl.appendChild(img);
  newCardEl.hidden = false;
  newCardEl.classList.add('pop');

  await sleep(3600);

  // 左へ流れ出てムービーに合流する
  const exit = newCardEl.animate(
    [
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
      { transform: 'translate(-120%, -50%) scale(0.5) rotate(-4deg)', opacity: 0 },
    ],
    { duration: 900, easing: 'ease-in' }
  );
  await new Promise((r) => (exit.onfinish = r));

  newCardEl.hidden = true;
  newCardEl.classList.remove('pop');
  newCardEl.innerHTML = '';
  toast.classList.remove('show');
  toast.hidden = true;
  release(photo.key);

  pool.push(photo);
  updateWaiting();
}

// ---- 全画面 ----
fsBtn.addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen().catch(() => {});
  }
});
