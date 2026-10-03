// 結婚式写真収集サイト Worker 本体(API + 静的配信フォールバック)

const MAX_SIZE = 95 * 1024 * 1024; // 1ファイル上限 95MB
const MAX_THUMB_SIZE = 1024 * 1024; // サムネイル上限 1MB
const THUMB_WINDOW_MS = 30 * 60 * 1000; // サムネイルは元写真の投稿から30分以内のみ受付
const RATE_LIMIT = 60; // 同一IPあたり 60アップロード/分
const RATE_WINDOW_MS = 60 * 1000;
const KEY_RE = /^photos\/\d{8}-\d{6}-[a-z0-9]{8}\.[a-z0-9]{1,8}$/;

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
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      ...headers,
    },
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

const thumbKeyOf = (key) => 'thumbs/' + key.slice('photos/'.length) + '.jpg';

function mediaType(request) {
  return (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
}

async function handleUpload(request, env) {
  const contentType = mediaType(request);
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

// 一覧表示用サムネイル(ブラウザ側で縮小したJPEG)。原寸写真とは別に保存する
async function handleThumb(request, env, url) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return json({ error: '不正なキーです。' }, 400);
  if (mediaType(request) !== 'image/jpeg') {
    return json({ error: 'サムネイルはJPEGのみ受け付けます。' }, 400);
  }
  const length = Number(request.headers.get('Content-Length') || '0');
  if (!length || length > MAX_THUMB_SIZE) {
    return json({ error: 'サムネイルのサイズが不正です。' }, 413);
  }

  const original = await env.PHOTOS.head(key);
  if (!original) return json({ error: '元の写真が見つかりません。' }, 404);
  if (Date.now() - original.uploaded.getTime() > THUMB_WINDOW_MS) {
    return json({ error: 'サムネイルの受付期限を過ぎています。' }, 403);
  }
  const thumbKey = thumbKeyOf(key);
  if (await env.PHOTOS.head(thumbKey)) {
    return json({ error: 'サムネイルは登録済みです。' }, 409);
  }

  await env.PHOTOS.put(thumbKey, request.body, { httpMetadata: { contentType: 'image/jpeg' } });
  return json({ ok: true });
}

async function listAll(env, prefix, include) {
  const objects = [];
  let cursor;
  do {
    const res = await env.PHOTOS.list({ prefix, cursor, include });
    objects.push(...res.objects);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return objects;
}

async function handlePhotos(env) {
  const [originals, thumbs] = await Promise.all([
    listAll(env, 'photos/', ['customMetadata', 'httpMetadata']),
    listAll(env, 'thumbs/', []),
  ]);
  const thumbSet = new Set(thumbs.map((o) => o.key));

  const photos = originals.map((o) => {
    let uploaderName = o.customMetadata?.uploaderName || '';
    try {
      uploaderName = decodeURIComponent(uploaderName);
    } catch (e) {
      // デコード不能ならそのまま
    }
    return {
      key: o.key,
      size: o.size,
      uploaded: o.uploaded,
      uploaderName,
      contentType: o.httpMetadata?.contentType || '',
      hasThumb: thumbSet.has(thumbKeyOf(o.key)),
    };
  });

  photos.sort((a, b) => b.key.localeCompare(a.key)); // 新しい順
  const totalSize = photos.reduce((sum, p) => sum + p.size, 0);
  // 一覧は読み取り専用。ありがとうサイト(gen1219.github.io)から取得できるよう CORS を許可する
  return json({ count: photos.length, totalSize, photos }, 200, {
    'Access-Control-Allow-Origin': '*',
  });
}

async function handlePhoto(request, env, url, key) {
  if (!KEY_RE.test(key)) {
    return json({ error: '不正なキーです。' }, 400);
  }
  const objKey = url.searchParams.get('size') === 'thumb' ? thumbKeyOf(key) : key;

  let obj;
  try {
    // Range 対応(iPhone Safari は動画再生に Range リクエストが必須)
    obj = await env.PHOTOS.get(objKey, { range: request.headers });
  } catch (e) {
    return new Response('範囲指定が不正です。', { status: 416 });
  }
  if (!obj) {
    return json({ error: 'ファイルが見つかりません。' }, 404);
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  // キーは一意で内容は変わらないため長期キャッシュしてよい
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Robots-Tag', 'noindex');
  headers.set('X-Content-Type-Options', 'nosniff');
  // SVG等を直接開かれてもスクリプトを実行させない
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  if (url.searchParams.get('dl') === '1') {
    headers.set('Content-Disposition', `attachment; filename="${key.slice('photos/'.length)}"`);
  }

  let status = 200;
  if (request.headers.has('Range') && obj.range) {
    let offset;
    let length;
    if (obj.range.suffix !== undefined) {
      length = Math.min(obj.range.suffix, obj.size);
      offset = obj.size - length;
    } else {
      offset = obj.range.offset ?? 0;
      length = obj.range.length ?? obj.size - offset;
    }
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('Content-Length', String(length));
    status = 206;
  }
  return new Response(obj.body, { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === '/api/upload' && request.method === 'POST') {
      // 誰でも投稿できるため、スパム対策としてアップロードのみ回数制限する
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rate = rateCheck(ip);
      if (rate.limited) {
        return json(
          { error: 'リクエストが多すぎます。しばらく待ってから再度お試しください。' },
          429,
          { 'Retry-After': String(rate.retryAfter) }
        );
      }
      return handleUpload(request, env);
    }
    if (url.pathname === '/api/thumb' && request.method === 'POST') {
      return handleThumb(request, env, url);
    }
    if (url.pathname === '/api/photos' && request.method === 'GET') {
      return handlePhotos(env);
    }
    if (url.pathname.startsWith('/api/photo/') && request.method === 'GET') {
      let key = url.pathname.slice('/api/photo/'.length);
      try {
        key = decodeURIComponent(key);
      } catch (e) {
        return json({ error: '不正なキーです。' }, 400);
      }
      return handlePhoto(request, env, url, key);
    }

    return json({ error: '見つかりません。' }, 404);
  },
};
