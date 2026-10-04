// 「みんなの写真」一覧と端末への保存
// app.js とグローバル名が衝突しないよう即時関数で囲む
(() => {
  const BATCH = 30; // 一度に描画する枚数
  const PREFETCH_MAX = 30 * 1024 * 1024; // これ以下は保存ボタン用に先読みする
  // まとめて保存はスマホのメモリに全件を読み込むため上限を設ける
  const SELECT_MAX = 20;
  const SELECT_MAX_BYTES = 200 * 1024 * 1024;
  const SELECT_FETCH_PARALLEL = 3;

  const $ = (id) => document.getElementById(id);
  const gridEl = $('grid');
  const statsEl = $('album-stats');
  const emptyEl = $('album-empty');
  const errEl = $('album-error');
  const refreshBtn = $('refresh-btn');
  const sentinel = $('sentinel');
  const lightbox = $('lightbox');
  const lbClose = $('lb-close');
  const lbContent = $('lb-content');
  const lbCaption = $('lb-caption');
  const lbSave = $('lb-save');
  const lbHint = $('lb-hint');
  const selectBtn = $('select-btn');
  const selectBar = $('select-bar');
  const selectInfo = $('select-info');
  const selectSave = $('select-save');

  // スマホは共有メニュー経由で「写真に保存」、PCは通常のダウンロード
  const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

  let photos = [];
  let rendered = 0;
  let loading = false;
  let selectMode = false;
  let shareMode = false; // 選択開始時に決める(共有メニューで保存するか、ダウンロードか)
  const selected = new Map(); // key -> { photo, file, failed }

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

  const fileName = (photo) => photo.key.slice('photos/'.length);

  function photoUrl(photo, { thumb = false, download = false } = {}) {
    const params = [];
    if (thumb) params.push('size=thumb');
    if (download) params.push('dl=1');
    return './api/photo/' + encodeURIComponent(photo.key) + (params.length ? '?' + params.join('&') : '');
  }

  // ---- 一覧 ----
  async function loadAlbum() {
    if (loading) return;
    loading = true;
    refreshBtn.disabled = true;
    try {
      const res = await fetch('./api/photos', { cache: 'no-store' });
      if (!res.ok) throw new Error('load failed');
      const data = await res.json();
      photos = data.photos;
      statsEl.textContent = `${data.count}件・合計 ${fmtSize(data.totalSize)}`;
      emptyEl.hidden = data.count > 0;
      errEl.hidden = true;
      gridEl.innerHTML = '';
      rendered = 0;
      renderMore();
    } catch (e) {
      errEl.textContent = '写真を読み込めませんでした。「最新にする」をお試しください。';
      errEl.hidden = false;
    } finally {
      loading = false;
      refreshBtn.disabled = false;
    }
  }

  function renderMore() {
    const end = Math.min(rendered + BATCH, photos.length);
    for (; rendered < end; rendered++) gridEl.appendChild(makeTile(photos[rendered]));
    // 画面が縦長で番兵がまだ見えている場合は続けて描画
    requestAnimationFrame(() => {
      if (rendered < photos.length && sentinel.getBoundingClientRect().top < window.innerHeight + 600) {
        renderMore();
      }
    });
  }

  new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting) && rendered < photos.length) renderMore();
    },
    { rootMargin: '600px' }
  ).observe(sentinel);

  function placeholder(text) {
    const span = document.createElement('span');
    span.className = 'ph';
    span.textContent = text;
    return span;
  }

  function makeTile(photo) {
    const isVideo = photo.contentType.startsWith('video/');
    const tile = document.createElement('div');
    tile.className = 'tile';

    if (selected.has(photo.key)) tile.classList.add('selected');

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const check = document.createElement('span');
    check.className = 'check';
    check.textContent = '✓';
    if (isVideo) {
      thumb.appendChild(placeholder('▶'));
    } else {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      // サムネイルが無い・読めない場合は原寸 → それも無理なら拡張子を表示
      let usedOriginal = !photo.hasThumb;
      img.onerror = () => {
        if (!usedOriginal) {
          usedOriginal = true;
          img.src = photoUrl(photo);
          return;
        }
        thumb.innerHTML = '';
        thumb.appendChild(placeholder((photo.key.split('.').pop() || '').toUpperCase()));
      };
      img.src = photoUrl(photo, { thumb: photo.hasThumb });
      thumb.appendChild(img);
    }

    const meta = document.createElement('div');
    meta.className = 'tile-meta';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = photo.uploaderName || '名前なし';
    const when = document.createElement('span');
    when.textContent = fmtDate(photo.uploaded);
    meta.append(who, when);

    tile.append(thumb, meta, check);
    tile.addEventListener('click', () => {
      if (selectMode) toggleSelect(photo, tile);
      else openLightbox(photo);
    });
    return tile;
  }

  refreshBtn.addEventListener('click', loadAlbum);
  window.refreshAlbum = loadAlbum;

  // ---- まとめて保存 ----
  function canShareFiles() {
    try {
      return (
        isTouch() &&
        !!navigator.canShare &&
        navigator.canShare({ files: [new File([''], 'x.jpg', { type: 'image/jpeg' })] })
      );
    } catch (e) {
      return false;
    }
  }

  function setSelectMode(on) {
    selectMode = on;
    selected.clear();
    fetchQueue.length = 0;
    shareMode = on && canShareFiles();
    clearTimeout(flashTimer);
    selectInfo.classList.remove('warn');
    document.body.classList.toggle('selecting', on);
    selectBtn.textContent = on ? 'キャンセル' : '選択';
    selectBar.hidden = !on;
    for (const t of gridEl.querySelectorAll('.tile.selected')) t.classList.remove('selected');
    updateBar();
  }

  selectBtn.addEventListener('click', () => setSelectMode(!selectMode));

  const selectedBytes = () => [...selected.values()].reduce((s, e) => s + e.photo.size, 0);

  let flashTimer = null;
  function flash(text) {
    selectInfo.textContent = text;
    selectInfo.classList.add('warn');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      selectInfo.classList.remove('warn');
      updateBar();
    }, 2500);
  }

  function toggleSelect(photo, tile) {
    if (selected.has(photo.key)) {
      selected.delete(photo.key);
      tile.classList.remove('selected');
      updateBar();
      return;
    }
    if (selected.size >= SELECT_MAX) {
      flash(`一度に保存できるのは${SELECT_MAX}件までです`);
      return;
    }
    if (selectedBytes() + photo.size > SELECT_MAX_BYTES) {
      flash('合計200MBを超えるため選択できません(動画は少なめに)');
      return;
    }
    const entry = { photo, file: null, failed: false };
    selected.set(photo.key, entry);
    tile.classList.add('selected');
    if (shareMode) enqueueFetch(entry);
    updateBar();
  }

  // 共有メニューはタップ直後にしか開けないため、選んだ時点で裏で読み込んでおく
  const fetchQueue = [];
  let fetching = 0;

  function enqueueFetch(entry) {
    fetchQueue.push(entry);
    pumpFetch();
  }

  function pumpFetch() {
    while (fetching < SELECT_FETCH_PARALLEL && fetchQueue.length > 0) {
      const entry = fetchQueue.shift();
      if (selected.get(entry.photo.key) !== entry) continue; // 選択解除済み
      fetching++;
      fetch(photoUrl(entry.photo))
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('fetch failed'))))
        .then((blob) => {
          entry.file = new File([blob], fileName(entry.photo), {
            type: blob.type || entry.photo.contentType,
          });
        })
        .catch(() => {
          entry.failed = true;
        })
        .finally(() => {
          fetching--;
          updateBar();
          pumpFetch();
        });
    }
  }

  function updateBar() {
    if (!selectMode || selectInfo.classList.contains('warn')) return;
    const entries = [...selected.values()];
    const n = entries.length;
    if (n === 0) {
      selectInfo.textContent = '保存する写真をタップして選んでください';
      selectSave.disabled = true;
      selectSave.textContent = '保存';
      return;
    }
    const failed = entries.filter((e) => e.failed).length;
    selectInfo.textContent =
      `${n}件を選択中(${fmtSize(selectedBytes())})` + (failed ? ` ・ ${failed}件は読み込み失敗` : '');
    const ready = entries.filter((e) => e.file || e.failed).length;
    if (shareMode && ready < n) {
      selectSave.disabled = true;
      selectSave.textContent = `準備中 ${ready}/${n}`;
    } else {
      selectSave.disabled = shareMode && failed === n;
      selectSave.textContent = `${n - failed}件を保存`;
    }
  }

  selectSave.addEventListener('click', async () => {
    const entries = [...selected.values()];
    if (entries.length === 0) return;

    if (shareMode) {
      const files = entries.filter((e) => e.file).map((e) => e.file);
      if (files.length && navigator.canShare({ files })) {
        try {
          await navigator.share({ files });
          setSelectMode(false);
          return;
        } catch (e) {
          if (e.name === 'AbortError') return; // 共有メニューを閉じただけ
        }
      }
    }

    // PC など: 1件ずつダウンロード(ブラウザが「複数ファイルのダウンロード」の許可を求めることがあります)
    selectSave.disabled = true;
    for (const e of entries) {
      download(e.photo);
      await new Promise((r) => setTimeout(r, 500));
    }
    setSelectMode(false);
  });

  // ---- 拡大表示と保存 ----
  let current = null; // { photo, file }

  function setSaveReady(ready) {
    lbSave.disabled = !ready;
    lbSave.textContent = ready ? '端末に保存' : '保存の準備中…';
  }

  function openLightbox(photo) {
    const isVideo = photo.contentType.startsWith('video/');
    const src = photoUrl(photo);
    const token = { photo, file: null };
    current = token;

    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
    lbCaption.textContent =
      `${photo.uploaderName || '名前なし'} ・ ${fmtDate(photo.uploaded)} ・ ${fmtSize(photo.size)}`;
    const touch = isTouch();
    lbHint.hidden = !touch || isVideo;
    lbContent.innerHTML = '';

    if (isVideo) {
      const video = document.createElement('video');
      video.src = src;
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      lbContent.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.alt = '';
      img.onerror = () => {
        lbContent.innerHTML = '';
        const msg = document.createElement('span');
        msg.className = 'lb-loading';
        msg.textContent = 'この形式はお使いの端末では表示できませんが、保存はできます。';
        lbContent.appendChild(msg);
      };
      img.src = src;
      lbContent.appendChild(img);
    }

    // iPhoneの共有メニューはタップ直後にしか開けないため、ファイルを先に取得しておく
    if (touch && navigator.canShare && photo.size <= PREFETCH_MAX) {
      setSaveReady(false);
      fetch(src)
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('fetch failed'))))
        .then((blob) => {
          token.file = new File([blob], fileName(photo), { type: blob.type || photo.contentType });
        })
        .catch(() => {})
        .finally(() => {
          if (current === token) setSaveReady(true);
        });
    } else {
      setSaveReady(true);
    }
  }

  function download(photo) {
    const a = document.createElement('a');
    a.href = photoUrl(photo, { download: true });
    a.download = fileName(photo);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  lbSave.addEventListener('click', async () => {
    const c = current;
    if (!c) return;
    if (c.file && navigator.canShare({ files: [c.file] })) {
      try {
        await navigator.share({ files: [c.file] });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return; // 共有メニューを閉じただけ
      }
    }
    download(c.photo);
  });

  function closeLightbox() {
    lightbox.hidden = true;
    lbContent.innerHTML = ''; // 動画の再生も止まる
    document.body.style.overflow = '';
    current = null;
  }

  lbClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !lightbox.hidden) closeLightbox();
  });

  loadAlbum();
})();
