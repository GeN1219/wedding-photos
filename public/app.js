// アップロードページのロジック
// 進捗表示が必要なため送信は XMLHttpRequest を使用(iOS Safari / Android Chrome 両対応)

const MAX_SIZE = 95 * 1024 * 1024; // 95MB
const MAX_PARALLEL = 3; // 同時アップロード数
const MAX_RETRY = 3; // 自動リトライ回数(指数バックオフ)
const MAX_RATE_WAITS = 5; // 429での待機回数上限
const THUMB_PX = 480; // 一覧用サムネイルの長辺

const $ = (id) => document.getElementById(id);

const formSection = $('form-section');
const progressSection = $('progress-section');
const doneSection = $('done-section');
const nameInput = $('uploader-name');
const fileInput = $('file-input');
const fileLabel = $('file-label');
const fileSummary = $('file-summary');
const formError = $('form-error');
const uploadBtn = $('upload-btn');
const progressTitle = $('progress-title');
const overallFill = $('overall-fill');
const overallText = $('overall-text');
const fileListEl = $('file-list');
const progressError = $('progress-error');
const retryBtn = $('retry-btn');
const doneMessage = $('done-message');
const moreBtn = $('more-btn');

// type が空のファイル(HEIC等)への拡張子フォールバック
const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
  webm: 'video/webm', '3gp': 'video/3gpp',
};

let items = []; // { file, mime, status, progress, error, el }
let uploading = false;

function mimeOf(file) {
  if (file.type && /^(image|video)\//.test(file.type)) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return EXT_MIME[ext] || '';
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- ファイル選択 ----
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files || []);
  items = files.map((file) => {
    const mime = mimeOf(file);
    let status = 'pending';
    let error = '';
    if (file.size > MAX_SIZE) {
      status = 'rejected';
      error = '95MBを超えているため送信できません';
    } else if (!mime) {
      status = 'rejected';
      error = '対応していないファイル形式です';
    }
    return { file, mime, status, progress: 0, error, el: null };
  });

  const ok = items.filter((i) => i.status === 'pending');
  const rejected = items.filter((i) => i.status === 'rejected');

  if (files.length === 0) {
    fileLabel.textContent = 'タップして写真・動画を選択';
    fileSummary.hidden = true;
  } else {
    fileLabel.textContent = '選び直す';
    const total = ok.reduce((s, i) => s + i.file.size, 0);
    fileSummary.textContent = `${ok.length}件を選択(合計 ${fmtSize(total)})`;
    fileSummary.hidden = false;
  }

  if (rejected.length > 0) {
    formError.textContent =
      `${rejected.length}件は送信できません: ` +
      rejected.map((i) => `${i.file.name}(${i.error})`).join(' / ');
    formError.hidden = false;
  } else {
    formError.hidden = true;
  }

  uploadBtn.disabled = ok.length === 0;
});

// ---- 送信開始 ----
uploadBtn.addEventListener('click', () => {
  formError.hidden = true;
  startUpload();
});

retryBtn.addEventListener('click', () => {
  items.forEach((i) => {
    if (i.status === 'failed') {
      i.status = 'pending';
      i.progress = 0;
      i.error = '';
    }
  });
  startUpload();
});

moreBtn.addEventListener('click', () => {
  items = [];
  fileInput.value = '';
  fileLabel.textContent = 'タップして写真・動画を選択';
  fileSummary.hidden = true;
  uploadBtn.disabled = true;
  doneSection.hidden = true;
  formSection.hidden = false;
});

async function startUpload() {
  if (uploading) return;
  uploading = true;

  formSection.hidden = true;
  doneSection.hidden = true;
  progressSection.hidden = false;
  progressError.hidden = true;
  retryBtn.hidden = true;
  progressTitle.textContent = '送信中…';

  renderFileList();
  updateOverall();

  const queue = items.filter((i) => i.status === 'pending');
  let idx = 0;

  const worker = async () => {
    while (idx < queue.length) {
      const item = queue[idx++];
      try {
        await uploadWithRetry(item);
      } catch (e) {
        item.status = 'failed';
        item.error = '送信に失敗しました';
      }
      updateItem(item);
      updateOverall();
    }
  };

  await Promise.all(Array.from({ length: MAX_PARALLEL }, worker));
  await thumbChain;
  uploading = false;
  if (window.refreshAlbum) window.refreshAlbum();

  const doneCount = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'failed');

  if (failed.length > 0) {
    progressTitle.textContent = '一部のファイルを送信できませんでした';
    progressError.textContent = `${failed.length}件が失敗しました。電波の良い場所で「再送」をお試しください。`;
    progressError.hidden = false;
    retryBtn.hidden = false;
  } else {
    progressSection.hidden = true;
    doneSection.hidden = false;
    doneMessage.textContent = `${doneCount}枚 送信完了。ありがとうございます!`;
  }
}

// 自動リトライ付きアップロード(指数バックオフ 1s → 2s → 4s)
async function uploadWithRetry(item) {
  let attempt = 0;
  let rateWaits = 0;
  item.error = '';

  while (true) {
    item.status = 'uploading';
    updateItem(item);
    try {
      const key = await uploadOne(item);
      item.status = 'done';
      item.progress = 1;
      if (key && item.mime.startsWith('image/')) queueThumb(item.file, key);
      return;
    } catch (err) {
      item.progress = 0;
      if (err.status === 400 || err.status === 413) {
        // リトライしても直らないエラー
        item.status = 'failed';
        item.error = err.message;
        return;
      }
      if (err.status === 429 && rateWaits < MAX_RATE_WAITS) {
        // レート制限 → サーバ指定の秒数だけ待って再試行(リトライ回数は消費しない)
        rateWaits++;
        item.status = 'waiting';
        updateItem(item);
        await sleep((err.retryAfter || 15) * 1000);
        continue;
      }
      if (attempt >= MAX_RETRY) {
        item.status = 'failed';
        item.error = err.message || '送信に失敗しました';
        return;
      }
      await sleep(1000 * 2 ** attempt + Math.random() * 300);
      attempt++;
    }
  }
}

function uploadOne(item) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', './api/upload');
    xhr.setRequestHeader('X-Uploader-Name', encodeURIComponent(nameInput.value.trim()));
    xhr.setRequestHeader('Content-Type', item.mime);
    xhr.timeout = 10 * 60 * 1000; // 大きい動画用に10分

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        item.progress = e.loaded / e.total;
        updateItem(item);
        updateOverall();
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let key = '';
        try {
          key = JSON.parse(xhr.responseText).key || '';
        } catch (e) { /* キーが取れなくてもアップロード自体は成功 */ }
        resolve(key);
      } else {
        let message = '送信に失敗しました';
        try {
          message = JSON.parse(xhr.responseText).error || message;
        } catch (e) { /* JSONでない応答 */ }
        const err = new Error(message);
        err.status = xhr.status;
        err.retryAfter = Number(xhr.getResponseHeader('Retry-After')) || 0;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('通信エラーが発生しました'));
    xhr.ontimeout = () => reject(new Error('通信がタイムアウトしました'));
    xhr.send(item.file);
  });
}

// ---- 一覧用サムネイル ----
// 原寸のまま保存しつつ、一覧の通信量を抑えるため端末側で縮小版を作って別送する。
// 大きな写真のデコードはメモリを食うため1枚ずつ順番に処理する。失敗しても投稿には影響しない。
let thumbChain = Promise.resolve();

function queueThumb(file, key) {
  thumbChain = thumbChain.then(() => sendThumb(file, key)).catch(() => {});
}

async function sendThumb(file, key) {
  const blob = await makeThumb(file);
  if (!blob) return;
  await fetch('./api/thumb?key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
  });
}

function makeThumb(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const done = (blob) => {
      URL.revokeObjectURL(url);
      resolve(blob);
    };
    img.onload = () => {
      try {
        const scale = Math.min(1, THUMB_PX / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          canvas.width = canvas.height = 0; // iOSのcanvasメモリを即解放
          done(blob);
        }, 'image/jpeg', 0.8);
      } catch (e) {
        done(null);
      }
    };
    img.onerror = () => done(null); // AndroidでのHEIC等、表示できない形式
    img.src = url;
  });
}

// ---- 表示更新 ----
const STATUS_TEXT = {
  pending: '待機中',
  uploading: '送信中',
  waiting: '混雑のため待機中',
  done: '完了 ✓',
  failed: '失敗',
  rejected: '送信不可',
};

function renderFileList() {
  fileListEl.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'file-item';

    const row = document.createElement('div');
    row.className = 'file-item-row';
    const name = document.createElement('span');
    name.className = 'file-item-name';
    name.textContent = `${item.file.name}(${fmtSize(item.file.size)})`;
    const status = document.createElement('span');
    status.className = 'file-item-status';
    row.append(name, status);

    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    bar.appendChild(fill);

    const errEl = document.createElement('div');
    errEl.className = 'file-item-error';
    errEl.hidden = true;

    li.append(row, bar, errEl);
    fileListEl.appendChild(li);
    item.el = { status, fill, errEl };
    updateItem(item);
  }
}

function updateItem(item) {
  if (!item.el) return;
  item.el.status.textContent = STATUS_TEXT[item.status] || '';
  item.el.status.className = `file-item-status st-${item.status}`;
  const pct = item.status === 'done' ? 100 : Math.round(item.progress * 100);
  item.el.fill.style.width = pct + '%';
  item.el.errEl.textContent = item.error || '';
  item.el.errEl.hidden = !item.error;
}

function updateOverall() {
  const targets = items.filter((i) => i.status !== 'rejected');
  const totalBytes = targets.reduce((s, i) => s + i.file.size, 0) || 1;
  let loaded = 0;
  for (const i of targets) {
    if (i.status === 'done') loaded += i.file.size;
    else if (i.status === 'uploading') loaded += i.file.size * i.progress;
  }
  const doneCount = targets.filter((i) => i.status === 'done').length;
  overallFill.style.width = Math.round((loaded / totalBytes) * 100) + '%';
  overallText.textContent = `${doneCount} / ${targets.length} 枚 完了`;
}
