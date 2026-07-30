// 結婚式写真収集サイト Worker 本体(API + 静的配信フォールバック)

const MAX_SIZE = 95 * 1024 * 1024; // 1ファイル上限 95MB
const RATE_LIMIT = 60; // 同一IPあたり 60リクエスト/分
const RATE_WINDOW_MS = 60 * 1000;

// Content-Type → 拡張子(不明なものは subtype をそのまま使う)
const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'video/3gpp': '3gp',
};

// 簡易レート制限(Workerインスタンス内メモリ。厳密ではない)
const rateMap = new Map();

function rateCheck(ip) {
  const now = Date.now();
  // 肥大化防止の掃除
  if (rateMap.size > 5000) {
    for (const [k, v] of rateMap) {
      if (now - v.start >= RATE_WINDOW_MS) rateMap.delete(k);
    }
  }
  const e = rateMap.get(ip);
  if (!e || now - e.start >= RATE_WINDOW_MS) {
    rateMap.set(ip, { start: now, count: 1 });
    return { limited: false };
  }
  e.count += 1;
  if (e.count > RATE_LIMIT) {
    return { limited: true, retryAfter: Math.ceil((e.start + RATE_WINDOW_MS - now) / 1000) };
  }
  return { limited: false };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

// JST(UTC+9)の YYYYMMDD-HHmmss
function timestampJST() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

function randomId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += chars[b % chars.length];
  return s;
}

async function handleUpload(request, env) {
  if (request.headers.get('X-Passcode') !== env.GUEST_PASSCODE) {
    return json({ error: '合言葉が違います。招待状をご確認ください。' }, 401);
  }

  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!/^(image|video)\//.test(contentType)) {
    return json({ error: '画像または動画のみアップロードできます。' }, 400);
  }

  const length = Number(request.headers.get('Content-Length') || '0');
  if (length > MAX_SIZE) {
    return json({ error: 'ファイルサイズは95MBまでです。' }, 413);
  }
  if (!length) {
    return json({ error: 'ファイルが空です。' }, 400);
  }

  const ext =
    EXT_BY_TYPE[contentType] ||
    contentType.split('/')[1].replace(/[^a-z0-9]/g, '').slice(0, 8) ||
    'bin';
  const key = `photos/${timestampJST()}-${randomId(8)}.${ext}`;

  // 投稿者名はURLエンコードのまま customMetadata に保存(非ASCII対策)
  const uploaderName = (request.headers.get('X-Uploader-Name') || '').slice(0, 300);

  try {
    await env.PHOTOS.put(key, request.body, {
      httpMetadata: { contentType },
      customMetadata: { uploaderName },
    });
  } catch (e) {
    return json({ error: '保存に失敗しました。時間をおいて再度お試しください。' }, 500);
  }

  return json({ ok: true, key });
}

async function handlePhotos(env) {
  const photos = [];
  let cursor;
  do {
    const res = await env.PHOTOS.list({
      prefix: 'photos/',
      cursor,
      include: ['customMetadata', 'httpMetadata'],
    });
    for (const o of res.objects) {
      let uploaderName = o.customMetadata?.uploaderName || '';
      try {
        uploaderName = decodeURIComponent(uploaderName);
      } catch (e) {
        // デコード不能ならそのまま
      }
      photos.push({
        key: o.key,
        size: o.size,
        uploaded: o.uploaded,
        uploaderName,
        contentType: o.httpMetadata?.contentType || '',
      });
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);

  photos.sort((a, b) => b.key.localeCompare(a.key)); // 新しい順
  const totalSize = photos.reduce((sum, p) => sum + p.size, 0);
  return json({ count: photos.length, totalSize, photos });
}

async function handlePhoto(env, key) {
  if (!key.startsWith('photos/') || key.includes('..')) {
    return json({ error: '不正なキーです。' }, 400);
  }
  const obj = await env.PHOTOS.get(key);
  if (!obj) {
    return json({ error: 'ファイルが見つかりません。' }, 404);
  }
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, max-age=86400');
  headers.set('ETag', obj.httpEtag);
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (!env.GUEST_PASSCODE || !env.ADMIN_PASSCODE) {
      return json({ error: 'サーバ設定エラー: 合言葉が未設定です(wrangler secret を設定してください)。' }, 500);
    }

    const isAdmin = request.headers.get('X-Admin-Passcode') === env.ADMIN_PASSCODE;

    // 管理パスコード認証済みリクエストは除外(ギャラリー閲覧は多数のGETが発生するため)
    if (!isAdmin) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rate = rateCheck(ip);
      if (rate.limited) {
        return json(
          { error: 'リクエストが多すぎます。しばらく待ってから再度お試しください。' },
          429,
          { 'Retry-After': String(rate.retryAfter) }
        );
      }
    }

    if (url.pathname === '/api/upload' && request.method === 'POST') {
      return handleUpload(request, env);
    }
    if (url.pathname === '/api/photos' && request.method === 'GET') {
      if (!isAdmin) return json({ error: 'パスコードが違います。' }, 401);
      return handlePhotos(env);
    }
    if (url.pathname.startsWith('/api/photo/') && request.method === 'GET') {
      if (!isAdmin) return json({ error: 'パスコードが違います。' }, 401);
      let key = url.pathname.slice('/api/photo/'.length);
      try {
        key = decodeURIComponent(key);
      } catch (e) {
        return json({ error: '不正なキーです。' }, 400);
      }
      return handlePhoto(env, key);
    }

    return json({ error: '見つかりません。' }, 404);
  },
};
