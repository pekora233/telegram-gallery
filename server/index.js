import { MongoClient, ObjectId } from 'mongodb';

// ========== JWT helpers (Web Crypto API, CF Workers compatible) ==========

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function base64UrlEncode(data) {
  let str;
  if (typeof data === 'string') {
    str = btoa(data);
  } else {
    // Uint8Array
    str = btoa(String.fromCharCode(...data));
  }
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function getSigningKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function jwtSign(payload, secret, expiresInSeconds = 365 * 24 * 3600) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getSigningKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(signingInput));

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function jwtVerify(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token');

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getSigningKey(secret);
  const signature = base64UrlDecode(signatureB64);
  const valid = await crypto.subtle.verify('HMAC', key, signature, textEncoder.encode(signingInput));

  if (!valid) throw new Error('Invalid signature');

  const payload = JSON.parse(textDecoder.decode(base64UrlDecode(payloadB64)));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  return payload;
}

// ========== Turnstile verification ==========

async function verifyTurnstileToken(token, ip, secretKey) {
  if (!secretKey) return true; // skip in dev

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: secretKey,
      response: token,
      remoteip: ip,
    }),
  });
  const data = await response.json();
  return data.success;
}

// ========== Telegram file URL helpers ==========

const TELEGRAM_OFFICIAL = 'https://api.telegram.org';
const TELEGRAM_PROXY = 'https://tgapi.kairod.cfd';

function buildUrlFromFilePath(botToken, filePath, useProxy = false) {
  if (!filePath) return null;
  if (useProxy) return `${TELEGRAM_PROXY}/file/bot${botToken}/${filePath}`;
  return `${TELEGRAM_OFFICIAL}/file/bot${botToken}/${filePath}`;
}

function extFromContentType(contentType) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/jxl': 'jxl',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
  };
  const base = (contentType || '').split(';')[0].trim().toLowerCase();
  return map[base] || 'bin';
}

const FILE_META_CACHE_TTL_MS = 10 * 60 * 1000;
const FILE_PATH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FILE_META_CACHE_MAX_ITEMS = 2000;
const FILE_PATH_CACHE_MAX_ITEMS = 4000;
const fileMetaCache = new Map();
const telegramPathCache = new Map();

function getCachedValue(cache, key) {
  const item = cache.get(key);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function setCachedValue(cache, key, value, ttlMs, maxItems) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (cache.size <= maxItems) return;

  const overflow = cache.size - maxItems;
  let removed = 0;
  for (const oldestKey of cache.keys()) {
    cache.delete(oldestKey);
    removed += 1;
    if (removed >= overflow) break;
  }
}

function normalizeExt(ext) {
  const value = String(ext || '').trim().toLowerCase().replace(/^\./, '');
  if (!value) return null;
  if (!/^[a-z0-9]{1,8}$/.test(value)) return null;
  return value;
}

function extFromFilenameHint(filenameHint) {
  if (!filenameHint) return null;
  const idx = filenameHint.lastIndexOf('.');
  if (idx < 0 || idx >= filenameHint.length - 1) return null;
  return normalizeExt(filenameHint.slice(idx + 1));
}

async function resolveTelegramFilePath(botToken, fileId, useProxy = false) {
  if (!botToken || !fileId) return null;
  const cacheKey = `${useProxy ? 'proxy' : 'official'}:${botToken}:${fileId}`;
  const cached = getCachedValue(telegramPathCache, cacheKey);
  if (cached) return cached;

  const base = useProxy ? TELEGRAM_PROXY : TELEGRAM_OFFICIAL;
  const resp = await fetch(`${base}/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  const filePath = data?.result?.file_path || null;
  if (!filePath) return null;

  setCachedValue(
    telegramPathCache,
    cacheKey,
    filePath,
    FILE_PATH_CACHE_TTL_MS,
    FILE_PATH_CACHE_MAX_ITEMS
  );
  return filePath;
}

async function lookupFileMetaFromDb(mongoUri, fileId) {
  if (!mongoUri || !fileId) return null;
  try {
    return await withMongo(mongoUri, async (db) => {
      const collection = db.collection('gallery');
      const doc = await collection.findOne(
        {
          $or: [
            { 'telegram.file_id': fileId },
            { 'telegram.file_id_lossy': fileId },
          ],
        },
        {
          projection: {
            _id: 1,
            'telegram.bot_token': 1,
            'telegram.file_id': 1,
            'telegram.file_id_lossy': 1,
            'telegram.file_id_format': 1,
            'telegram.file_id_lossy_format': 1,
          },
        }
      );
      if (!doc) return null;

      let dbFormat = null;
      if (doc.telegram) {
        if (fileId === doc.telegram.file_id && doc.telegram.file_id_format) {
          dbFormat = doc.telegram.file_id_format;
        } else if (fileId === doc.telegram.file_id_lossy && doc.telegram.file_id_lossy_format) {
          dbFormat = doc.telegram.file_id_lossy_format;
        }
      }

      return {
        botToken: doc.telegram?.bot_token || null,
        docId: doc._id?.toString() || null,
        dbFormat: normalizeExt(dbFormat),
      };
    });
  } catch (e) {
    return null;
  }
}

// ========== MongoDB helper ==========

async function withMongo(mongoUri, fn) {
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db('magic_plugin_db');
    return await fn(db);
  } finally {
    await client.close();
  }
}

// ========== CORS headers ==========

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

// ========== Route: /api/login ==========

async function handleLogin(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  }

  const body = await request.json().catch(() => ({}));
  const { username, password, turnstileToken } = body;

  const USER = env.GALLERY_USER || 'admin';
  const PASS = env.GALLERY_PASS || 'password';
  const SECRET = env.JWT_SECRET || 'change-me';

  // Verify Turnstile
  if (turnstileToken) {
    const clientIp = request.headers.get('cf-connecting-ip') ||
                     request.headers.get('x-forwarded-for')?.split(',')[0] || '';
    const isValid = await verifyTurnstileToken(turnstileToken, clientIp, env.TURNSTILE_SECRET_KEY);
    if (!isValid) {
      return jsonResponse({ error: '人机验证失败，请重试' }, 403);
    }
  }

  if (!username || !password || username !== USER || password !== PASS) {
    return jsonResponse({ error: '用户名或密码错误' }, 401);
  }

  const token = await jwtSign({ user: username }, SECRET);
  return jsonResponse({ token });
}

// ========== Route: /api/gallery ==========

async function handleGallery(request, env) {
  if (request.method !== 'GET' && request.method !== 'DELETE') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  }

  // Auth
  const auth = (request.headers.get('authorization') || '').split(' ')[1];
  const SECRET = env.JWT_SECRET || 'change-me';
  try {
    if (!auth) throw new Error('No token');
    await jwtVerify(auth, SECRET);
  } catch (e) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const MONGO_URI = env.MONGO_URI;
  if (!MONGO_URI) {
    return jsonResponse({ error: 'MONGO_URI not configured' }, 500);
  }

  return withMongo(MONGO_URI, async (db) => {
    const collection = db.collection('gallery');

    if (request.method === 'DELETE') {
      const body = await request.json().catch(() => ({}));
      const id = body?.id;
      if (!id) {
        return jsonResponse({ error: 'Missing id' }, 400);
      }
      try {
        const result = await collection.deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 1) {
          return jsonResponse({ ok: true, deletedId: id });
        } else {
          return jsonResponse({ error: 'Not found' }, 404);
        }
      } catch (e) {
        return jsonResponse({ error: String(e) }, 500);
      }
    }

    // GET: gallery list
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get('limit');
    const cursorRaw = url.searchParams.get('cursor');
    const sortRaw = url.searchParams.get('sort');
    const cursor = typeof cursorRaw === 'string' ? cursorRaw.trim() : '';
    const ascending = sortRaw === 'asc';
    const wantsPagination = limitRaw !== null || Boolean(cursor);
    const decodeCursor = (rawCursor) => {
      if (!rawCursor) return null;

      // Backward compatibility for old "timestamp|id" cursor format.
      const legacySep = rawCursor.indexOf('|');
      if (legacySep > 0) {
        rawCursor = rawCursor.slice(0, legacySep);
      }

      if (rawCursor.startsWith('d:')) {
        const date = new Date(rawCursor.slice(2));
        if (!Number.isNaN(date.getTime())) return date;
        return rawCursor.slice(2);
      }

      if (rawCursor.startsWith('r:')) {
        return rawCursor.slice(2);
      }

      const date = new Date(rawCursor);
      if (!Number.isNaN(date.getTime())) return date;
      return rawCursor;
    };
    const encodeCursor = (value) => {
      if (value instanceof Date) {
        return `d:${value.toISOString()}`;
      }
      return `r:${String(value ?? '')}`;
    };

    const toGalleryItem = (d) => ({
      id: d._id.toString(),
      prompt: d.prompt,
      metadata: d.metadata || {},
      telegram: {
        chat_id: d.telegram?.chat_id || null,
        file_id: d.telegram?.file_id || null,
        file_id_lossy: d.telegram?.file_id_lossy || null,
        file_id_format: d.telegram?.file_id_format || null,
        file_id_lossy_format: d.telegram?.file_id_lossy_format || null,
        prev_file_id_format: d.telegram?.prev_file_id_format || null,
      },
      timestamp: d.timestamp instanceof Date ? d.timestamp.toISOString() : (d.timestamp || null),
    });

    if (wantsPagination) {
      const parsedLimit = parseInt(String(limitRaw ?? ''), 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(parsedLimit, 200))
        : 60;

      let query = {};
      if (cursor) {
        const op = ascending ? '$gt' : '$lt';
        const cursorValue = decodeCursor(cursor);
        query = { timestamp: { [op]: cursorValue } };
      }

      const sortDir = ascending ? 1 : -1;
      const docs = await collection
        .find(query, { projection: { prompt: 1, metadata: 1, telegram: 1, timestamp: 1 } })
        .sort({ timestamp: sortDir })
        .limit(limit + 1)
        .toArray();

      const hasMore = docs.length > limit;
      const pageDocs = hasMore ? docs.slice(0, limit) : docs;
      const items = pageDocs.map(toGalleryItem);
      const lastDoc = pageDocs[pageDocs.length - 1];
      const nextCursor = hasMore && lastDoc
        ? encodeCursor(lastDoc.timestamp)
        : null;

      return jsonResponse(
        { items, hasMore, nextCursor, limit },
        200,
        { 'Cache-Control': 'public, max-age=60' }
      );
    }

    // Legacy: return up to 200 items
    const docs = await collection
      .find({}, { projection: { prompt: 1, metadata: 1, telegram: 1, timestamp: 1 } })
      .sort({ timestamp: -1 })
      .limit(200)
      .toArray();

    return jsonResponse(
      docs.map(toGalleryItem),
      200,
      { 'Cache-Control': 'public, max-age=60' }
    );
  });
}

// ========== Route: /api/fileurl ==========

async function handleFileUrl(request, env, ctx) {
  const url = new URL(request.url);
  const file_id = url.searchParams.get('file_id');
  if (!file_id) {
    return jsonResponse({ error: 'file_id required' }, 400);
  }

  const edgeCache = (request.method === 'GET' && typeof caches !== 'undefined' && caches.default)
    ? caches.default
    : null;
  const edgeCacheKey = edgeCache
    ? new Request(`${url.origin}/__edge_cache/file?file_id=${encodeURIComponent(file_id)}`, { method: 'GET' })
    : null;

  if (edgeCache && edgeCacheKey) {
    const cachedResponse = await edgeCache.match(edgeCacheKey);
    if (cachedResponse) {
      return cachedResponse;
    }
  }

  const filenameHint = url.searchParams.get('filename_hint') || '';
  const hintedExt = extFromFilenameHint(filenameHint);
  const MONGO_URI = env.MONGO_URI;
  const cachedMeta = getCachedValue(fileMetaCache, file_id);
  let botToken = cachedMeta?.botToken || env.BOT_TOKEN || null;
  let docId = cachedMeta?.docId || null;
  let dbFormat = normalizeExt(cachedMeta?.dbFormat) || hintedExt;

  async function loadDbMeta() {
    const inMemory = getCachedValue(fileMetaCache, file_id);
    if (inMemory) return inMemory;
    const fromDb = await lookupFileMetaFromDb(MONGO_URI, file_id);
    if (!fromDb) return null;
    setCachedValue(fileMetaCache, file_id, fromDb, FILE_META_CACHE_TTL_MS, FILE_META_CACHE_MAX_ITEMS);
    return fromDb;
  }

  if (!botToken) {
    const dbMeta = await loadDbMeta();
    botToken = dbMeta?.botToken || null;
    docId = dbMeta?.docId || null;
    dbFormat = normalizeExt(dbMeta?.dbFormat) || dbFormat;
    if (!botToken) {
      return jsonResponse({ error: 'No bot token available' }, 500);
    }
  }

  function buildImageResponse(imageResp, filePath) {
    const contentType = imageResp.headers.get('content-type') || 'application/octet-stream';
    // Prefer format from DB, then Content-Type, then file_path extension
    const pathExt = normalizeExt(filePath && filePath.includes('.') ? filePath.split('.').pop() : null);
    const ctExt = extFromContentType(contentType);
    const ext = normalizeExt(dbFormat) || hintedExt || (ctExt !== 'bin' ? ctExt : (pathExt || hintedExt || 'bin'));
    const filenameBase = docId || file_id.slice(0, 16);
    const filename = `${filenameBase}.${ext}`;
    return new Response(imageResp.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'CDN-Cache-Control': 'public, max-age=31536000, immutable',
        ...corsHeaders(),
      },
    });
  }

  async function cacheAndReturn(response) {
    if (!response || response.status !== 200 || !edgeCache || !edgeCacheKey) {
      return response;
    }

    try {
      const putPromise = edgeCache.put(edgeCacheKey, response.clone());
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(putPromise);
      } else {
        await putPromise;
      }
    } catch (e) {
      // ignore edge cache write failures and still serve origin response
    }
    return response;
  }

  async function fetchWithToken(token, useProxy = false) {
    const filePath = await resolveTelegramFilePath(token, file_id, useProxy);
    if (!filePath) return null;

    const urlDirect = buildUrlFromFilePath(token, filePath, useProxy);
    const imageResp = await fetch(urlDirect).catch(() => null);
    if (!imageResp || !imageResp.ok) return null;
    return buildImageResponse(imageResp, filePath);
  }

  const triedTokens = new Set();
  async function tryFetchWithToken(token) {
    if (!token || triedTokens.has(token)) return null;
    triedTokens.add(token);

    let response = await fetchWithToken(token, false);
    if (response) return response;
    response = await fetchWithToken(token, true);
    return response;
  }

  let imageResponse = await tryFetchWithToken(botToken);
  if (imageResponse) return cacheAndReturn(imageResponse);

  // env.BOT_TOKEN fails: try DB token as fallback (and cache it).
  const dbMeta = await loadDbMeta();
  if (dbMeta) {
    docId = dbMeta.docId || docId;
    dbFormat = normalizeExt(dbMeta.dbFormat) || dbFormat;
    imageResponse = await tryFetchWithToken(dbMeta.botToken || botToken);
    if (imageResponse) return cacheAndReturn(imageResponse);
  }

  return jsonResponse({ error: 'Failed to retrieve file URL' }, 502);
}

// ========== Route: /api/gallery/categories ==========

function parseTags(prompt) {
  if (!prompt) return [];
  return prompt
    .replace(/[()]/g, '')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(t => t);
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

async function handleCategories(request, env) {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  }

  const auth = (request.headers.get('authorization') || '').split(' ')[1];
  const SECRET = env.JWT_SECRET || 'change-me';
  try {
    if (!auth) throw new Error('No token');
    await jwtVerify(auth, SECRET);
  } catch (e) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const MONGO_URI = env.MONGO_URI;
  if (!MONGO_URI) {
    return jsonResponse({ error: 'MONGO_URI not configured' }, 500);
  }

  return withMongo(MONGO_URI, async (db) => {
    const collection = db.collection('gallery');
    const docs = await collection
      .find({}, { projection: { prompt: 1, timestamp: 1 } })
      .sort({ _id: -1 })
      .toArray();

    const THRESHOLD = 0.85;
    const categories = [];

    for (const doc of docs) {
      const tags = parseTags(doc.prompt);
      if (tags.length === 0) continue; // 跳过没有 prompt 的记录
      const tagSet = new Set(tags);
      let matched = false;

      for (const cat of categories) {
        if (jaccardSimilarity(tagSet, cat.tagSet) >= THRESHOLD) {
          cat.items.push(doc._id.toString());
          cat.count++;
          matched = true;
          break;
        }
      }

      if (!matched) {
        categories.push({
          id: categories.length,
          tags,
          tagSet,
          count: 1,
          items: [doc._id.toString()],
        });
      }
    }

    const result = categories.map(({ tagSet, ...rest }) => rest);

    return jsonResponse({
      categories: result,
      totalItems: docs.length,
      totalCategories: categories.length,
    }, 200, { 'Cache-Control': 'public, max-age=120' });
  });
}

// ========== Route: /api/gallery/stats ==========

async function handleStats(request, env) {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  }

  const auth = (request.headers.get('authorization') || '').split(' ')[1];
  const SECRET = env.JWT_SECRET || 'change-me';
  try {
    if (!auth) throw new Error('No token');
    await jwtVerify(auth, SECRET);
  } catch (e) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const MONGO_URI = env.MONGO_URI;
  if (!MONGO_URI) {
    return jsonResponse({ error: 'MONGO_URI not configured' }, 500);
  }

  return withMongo(MONGO_URI, async (db) => {
    const collection = db.collection('gallery');
    const docs = await collection
      .find({}, { projection: { prompt: 1, metadata: 1, telegram: 1, timestamp: 1 } })
      .sort({ _id: -1 })
      .toArray();

    const models = {};
    let oldest = null;
    let newest = null;

    const items = docs.map((d) => {
      const rawTs = d.timestamp;
      // 统一转为 ISO 字符串进行比较
      const ts = rawTs instanceof Date ? rawTs.toISOString() : (rawTs || null);
      if (ts) {
        if (!oldest || ts < oldest) oldest = ts;
        if (!newest || ts > newest) newest = ts;
      }
      const model = d.metadata?.model || 'unknown';
      models[model] = (models[model] || 0) + 1;

      return {
        id: d._id.toString(),
        prompt: d.prompt,
        metadata: d.metadata || {},
        telegram: {
          chat_id: d.telegram?.chat_id || null,
          file_id: d.telegram?.file_id || null,
          file_id_lossy: d.telegram?.file_id_lossy || null,
          file_id_format: d.telegram?.file_id_format || null,
          file_id_lossy_format: d.telegram?.file_id_lossy_format || null,
          prev_file_id_format: d.telegram?.prev_file_id_format || null,
        },
        timestamp: ts,
      };
    });

    return jsonResponse({
      totalItems: docs.length,
      oldestTimestamp: oldest,
      newestTimestamp: newest,
      models,
      items,
    }, 200, { 'Cache-Control': 'public, max-age=60' });
  });
}

// ========== Main Worker ==========

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: corsHeaders(),
      });
    }

    // API routing
    if (url.pathname === '/api/login') {
      return handleLogin(request, env);
    }
    if (url.pathname === '/api/gallery') {
      return handleGallery(request, env);
    }
    if (url.pathname === '/api/gallery/categories') {
      return handleCategories(request, env);
    }
    if (url.pathname === '/api/gallery/stats') {
      return handleStats(request, env);
    }
    if (url.pathname === '/api/fileurl') {
      return handleFileUrl(request, env, ctx);
    }
    // /api/file/<file_id>/<filename> — browser-friendly URL with proper filename
    if (url.pathname.startsWith('/api/file/')) {
      const segments = url.pathname.slice('/api/file/'.length).split('/');
      const fileId = decodeURIComponent(segments[0] || '');
      const filenameHint = decodeURIComponent(segments[1] || '');
      if (fileId) {
        url.searchParams.set('file_id', fileId);
        if (filenameHint) {
          url.searchParams.set('filename_hint', filenameHint);
        }
        const newReq = new Request(url.toString(), request);
        return handleFileUrl(newReq, env, ctx);
      }
    }
    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ error: 'Not Found' }, 404);
    }

    // Non-API routes are handled by the assets (SPA)
    return new Response(null, { status: 404 });
  },
};
