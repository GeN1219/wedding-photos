// ライブムービーページ(会場スクリーン投影用)
// 5秒ごとに新着をポーリングし、写真を右から左へ流す。
// 新着写真は「届きました!」の演出後にムービーへ合流する。

const POLL_MS = 5000; // 新着確認の間隔
const SPAWN_MS = 2200; // 写真を流し始める間隔
const MAX_CARDS = 16; // 同時に流れる最大枚数
const CACHE_MAX = 40; // blob URLキャッシュ上限

// 重なりを防ぐためのレーン設定。
// 上下2段は大きめ(遠くの席からの視認用)、中央は小さめの賑やかし。
// 同一レーン内は速度を完全に固定して追い抜きをなくし、
// さらに前のカードが自分の幅+間隔ぶん進むまで次を出さない。
const LANES = [
  { top: 2, height: 40, duration: 30000, min: 30, max: 38, gap: 90 }, // 上段(大)
  { top: 43, height: 14, duration: 22000, min: 12, max: 14, gap: 60 }, // 中段(小)
  { top: 58, height: 38, duration: 36000, min: 30, max: 38, gap: 90 }, // 下段(大)
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
  startBaseball();

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
function spawnTick() {
  if (document.hidden) return;
  if (activeCards >= MAX_CARDS) return;
  // 空いているレーン(前のカードが十分進んだレーン)からランダムに選ぶ
  const now = Date.now();
  const free = LANES.filter((l) => (l.busyUntil || 0) <= now);
  if (free.length === 0) return;
  const lane = free[Math.floor(Math.random() * free.length)];
  const photo = nextPhoto();
  if (photo) spawnCard(photo, lane);
}

async function spawnCard(photo, lane) {
  activeCards++;
  lane.busyUntil = Date.now() + 5000; // 画像読み込み中の仮押さえ
  try {
    const url = await acquire(photo.key);
    const card = document.createElement('div');
    card.className = lane.max < 20 ? 'float-card float-card-s' : 'float-card';
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

    const h = lane.min + Math.random() * (lane.max - lane.min);
    card.style.height = h + 'vh';
    card.style.top = lane.top + Math.random() * (lane.height - h) + 'vh';
    cardsEl.appendChild(card);

    const width = card.offsetWidth;
    const dur = lane.duration; // レーン内は完全に同速(追い抜きなし)
    const travel = window.innerWidth + width + 120;
    // このカードが「自分の幅+間隔」ぶん進むまでレーンを塞ぐ
    lane.busyUntil = Date.now() + ((width + lane.gap) / (travel / dur));

    const rot = Math.random() * 8 - 4;
    const anim = card.animate(
      [
        { transform: `translateX(100vw) rotate(${rot}deg)` },
        { transform: `translateX(${-(width + 120)}px) rotate(${rot}deg)` },
      ],
      { duration: dur, easing: 'linear' }
    );
    anim.onfinish = () => {
      card.remove();
      release(photo.key);
      activeCards--;
    };
  } catch (e) {
    lane.busyUntil = Date.now();
    release(photo.key);
    activeCards--;
  }
}

// ---- 野球シルエット演出 ----
const BB_COLOR = 'rgba(70, 112, 140, 0.34)';
let bbLayer = null;

function ballSVG(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 40 40">
    <circle cx="20" cy="20" r="18" fill="${BB_COLOR}"/>
    <path d="M9 6 Q22 20 9 34" stroke="rgba(234,247,255,0.85)" stroke-width="2.4" fill="none"/>
    <path d="M31 6 Q18 20 31 34" stroke="rgba(234,247,255,0.85)" stroke-width="2.4" fill="none"/>
  </svg>`;
}

// バッターのシルエット(フォロースルーの姿勢)
function batterSVG(size, flip) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 120 120"
    style="${flip ? 'transform:scaleX(-1);' : ''}">
    <g fill="${BB_COLOR}">
      <circle cx="46" cy="20" r="10"/>
      <path d="M36 30 L56 30 L62 64 L36 64 Z"/>
      <path d="M38 62 L22 96 L30 99 L48 68 Z"/>
      <path d="M54 62 L68 94 L60 97 L46 68 Z"/>
    </g>
    <path d="M54 36 L76 28" stroke="${BB_COLOR}" stroke-width="8" stroke-linecap="round" fill="none"/>
    <path d="M76 28 L106 4" stroke="${BB_COLOR}" stroke-width="9" stroke-linecap="round" fill="none"/>
  </svg>`;
}

// 放物線のキーフレームを生成(2次ベジェを分割)
function arcKeyframes(x0, y0, cx, cy, x1, y1, spin) {
  const frames = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t ** 2 * x1;
    const y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t ** 2 * y1;
    frames.push({ transform: `translate(${x}px, ${y}px) rotate(${spin * t}deg)` });
  }
  return frames;
}

function flyBall(x0, y0, cx, cy, x1, y1, dur, size) {
  const el = document.createElement('div');
  el.className = 'bb-item';
  el.innerHTML = ballSVG(size);
  bbLayer.appendChild(el);
  const anim = el.animate(arcKeyframes(x0, y0, cx, cy, x1, y1, 720), {
    duration: dur,
    easing: 'linear',
  });
  anim.onfinish = () => el.remove();
}

// 時々ボールがゆるやかに横切る
function ambientBall() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const ltr = Math.random() < 0.5;
  const y = H * (0.25 + Math.random() * 0.5);
  const peak = y - H * (0.15 + Math.random() * 0.2);
  const size = 22 + Math.random() * 14;
  if (ltr) flyBall(-50, y, W * 0.5, peak, W + 50, y - H * 0.05, 3800 + Math.random() * 2000, size);
  else flyBall(W + 50, y, W * 0.5, peak, -50, y - H * 0.05, 3800 + Math.random() * 2000, size);
}

// バッターが現れてスイング → 打球が飛んでいく
async function batterSwing() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const flip = Math.random() < 0.5; // false: 左下から右へ打つ / true: 右下から左へ
  const size = Math.max(120, H * 0.2);

  const batter = document.createElement('div');
  batter.className = 'bb-item bb-batter';
  batter.innerHTML = batterSVG(size, flip);
  batter.style.left = flip ? 'auto' : '3vw';
  batter.style.right = flip ? '3vw' : 'auto';
  batter.style.bottom = '3vh';
  bbLayer.appendChild(batter);

  // 現れる → ひと呼吸おいてスイング(素早い傾き)
  batter.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, fill: 'forwards' });
  await sleep(700);
  batter.animate(
    [
      { transform: 'rotate(0deg)' },
      { transform: `rotate(${flip ? 14 : -14}deg)` },
      { transform: 'rotate(0deg)' },
    ],
    { duration: 360, easing: 'ease-out' }
  );
  await sleep(180); // インパクトの瞬間

  // 打球発射
  const x0 = flip ? W - W * 0.08 : W * 0.08;
  const x1 = flip ? -60 : W + 60;
  const cx = W * 0.5;
  flyBall(x0, H * 0.82, cx, -H * 0.15, x1, H * (0.15 + Math.random() * 0.25), 2600, 30);

  await sleep(1500);
  const fade = batter.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500 });
  await new Promise((r) => (fade.onfinish = r));
  batter.remove();
}

function startBaseball() {
  bbLayer = document.createElement('div');
  bbLayer.className = 'bb-layer';
  stage.insertBefore(bbLayer, cardsEl);

  const loopBall = () => {
    setTimeout(() => {
      if (!document.hidden) ambientBall();
      loopBall();
    }, 6000 + Math.random() * 7000);
  };
  const loopSwing = () => {
    setTimeout(() => {
      if (!document.hidden) batterSwing();
      loopSwing();
    }, 11000 + Math.random() * 9000);
  };
  loopBall();
  loopSwing();
  batterSwing(); // 開始直後に一度見せる
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
