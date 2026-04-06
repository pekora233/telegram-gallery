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

// ========== CAPTCHA verification ==========

async function verifyTurnstileToken(token, ip, secretKey) {
  if (!token || !secretKey) return false;

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: secretKey,
        response: token,
        remoteip: ip,
      }),
    });
    if (!response.ok) return false;
    const data = await response.json().catch(() => null);
    return Boolean(data?.success);
  } catch (e) {
    return false;
  }
}

async function verifyHCaptchaToken(token, ip, secretKey) {
  if (!token || !secretKey) return false;

  try {
    const body = new URLSearchParams();
    body.set('secret', secretKey);
    body.set('response', token);
    if (ip) body.set('remoteip', ip);

    const response = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) return false;
    const data = await response.json().catch(() => null);
    return Boolean(data?.success);
  } catch (e) {
    return false;
  }
}

// ========== Telegram file URL helpers ==========

const TELEGRAM_OFFICIAL = 'https://api.telegram.org';

function buildUrlFromFilePath(botToken, filePath) {
  if (!filePath) return null;
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

function parseBotTokenList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\n,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

const FETCH_TIMEOUT_MS = 8000;
const TELEGRAM_FETCH_RETRIES = 2;
const TELEGRAM_FETCH_RETRY_BASE_DELAY_MS = 250;
const TELEGRAM_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableTelegramStatus(status) {
  return TELEGRAM_RETRYABLE_STATUS.has(status);
}

async function fetchTelegramWithRetry(
  url,
  opts = {},
  {
    retries = TELEGRAM_FETCH_RETRIES,
    timeoutMs = FETCH_TIMEOUT_MS,
    baseDelayMs = TELEGRAM_FETCH_RETRY_BASE_DELAY_MS,
  } = {}
) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, opts, timeoutMs);
      if (!isRetryableTelegramStatus(resp.status) || attempt === retries) {
        return resp;
      }
    } catch (e) {
      if (attempt === retries) throw e;
    }

    const delayMs = baseDelayMs * (2 ** attempt);
    await sleep(delayMs);
  }
  return null;
}

async function resolveTelegramFilePath(botToken, fileId) {
  if (!botToken || !fileId) return null;
  const cacheKey = `${botToken}:${fileId}`;
  const cached = getCachedValue(telegramPathCache, cacheKey);
  if (cached) return cached;

  const url = `${TELEGRAM_OFFICIAL}/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;

  try {
    const resp = await fetchTelegramWithRetry(url);
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
  } catch (e) {
    return null;
  }
}

const GALLERY_D1_TABLE = 'gallery_archive';

function getD1Database(env) {
  return env?.DB || null;
}

function getGalleryDbMode(env) {
  if (getD1Database(env)) return 'd1';
  if (env?.MONGO_URI) return 'mongo';
  return null;
}

function bindD1Statement(env, sql, params = []) {
  const database = getD1Database(env);
  if (!database) {
    throw new Error('D1 not configured');
  }

  const statement = database.prepare(sql);
  return params.length > 0 ? statement.bind(...params) : statement;
}

async function queryD1(env, sql, params = []) {
  const result = await bindD1Statement(env, sql, params).all();
  return result;
}

async function executeD1(env, sql, params = []) {
  return bindD1Statement(env, sql, params).run();
}

function getD1Rows(result) {
  if (!result?.results || !Array.isArray(result.results)) return [];
  return result.results;
}

function getD1Changes(result) {
  return Number(result?.meta?.changes || 0);
}

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (e) {
    return fallback;
  }
}

function rowToGalleryItem(row) {
  const metadata = parseJsonObject(row.metadata_json || row.metadata || {});
  const telegram = parseJsonObject(row.telegram_json || row.telegram || {});
  const id = row.mongo_id || row._id || row.id || '';

  return {
    id: String(id),
    prompt: row.prompt || null,
    metadata,
    telegram: {
      chat_id: row.chat_id || telegram.chat_id || null,
      file_id: row.file_id || telegram.file_id || null,
      file_id_lossy: row.file_id_lossy || telegram.file_id_lossy || null,
      file_id_format: row.file_id_format || telegram.file_id_format || null,
      file_id_lossy_format: row.file_id_lossy_format || telegram.file_id_lossy_format || null,
      prev_file_id_format: row.prev_file_id_format || telegram.prev_file_id_format || null,
    },
    timestamp: row.timestamp_iso || row.timestamp || null,
  };
}

function rowToFileMeta(row) {
  if (!row) return null;
  const telegram = parseJsonObject(row.telegram_json || row.telegram || {});
  const id = row.mongo_id || row._id || row.id || '';
  return {
    botToken: row.bot_token || telegram.bot_token || null,
    docId: String(id) || null,
    dbFormat: normalizeExt(row.file_id_format) || normalizeExt(row.file_id_lossy_format) || null,
  };
}

async function lookupFileMetaFromDb(env, fileId) {
  if (!fileId) return null;

  if (getD1Database(env)) {
    try {
      const result = await queryD1(
        env,
        `
          SELECT mongo_id, bot_token, file_id, file_id_lossy, file_id_format, file_id_lossy_format, telegram_json
          FROM ${GALLERY_D1_TABLE}
          WHERE file_id = ? OR file_id_lossy = ?
          LIMIT 1
        `,
        [fileId, fileId]
      );
      return rowToFileMeta(getD1Rows(result)[0] || null);
    } catch (e) {
      return null;
    }
  }

  const mongoUri = env?.MONGO_URI || null;
  if (!mongoUri) return null;

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

const MONGO_CONNECT_TIMEOUT_MS = 5000;
const MONGO_SOCKET_TIMEOUT_MS = 10000;
const MONGO_SERVER_SELECTION_TIMEOUT_MS = 5000;
const GALLERY_MAX_PAGE_SPAN = 6;
const GALLERY_COUNT_CACHE_TTL_MS = 30 * 1000;
let galleryCountCacheValue = null;
let galleryCountCacheExpiresAt = 0;

/**
 * Stateless MongoDB helper — creates a fresh client per request and closes it
 * when done. Cloudflare Workers are stateless; global client caching leads to
 * stale/dead sockets that hang the entire Worker.
 */
async function withMongo(mongoUri, fn) {
  const client = new MongoClient(mongoUri, {
    connectTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
    socketTimeoutMS: MONGO_SOCKET_TIMEOUT_MS,
    serverSelectionTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
    maxPoolSize: 1,
    minPoolSize: 0,
    maxIdleTimeMS: 10000,
  });
  try {
    await client.connect();
    const db = client.db('magic_plugin_db');
    return await fn(db);
  } finally {
    // Always close — don't let sockets linger across isolate reuses.
    try { await client.close(); } catch (_) { /* ignore */ }
  }
}

async function getCachedEstimatedGalleryCount(fetchCount) {
  if (galleryCountCacheValue !== null && galleryCountCacheExpiresAt > Date.now()) {
    return galleryCountCacheValue;
  }
  const total = await fetchCount();
  galleryCountCacheValue = total;
  galleryCountCacheExpiresAt = Date.now() + GALLERY_COUNT_CACHE_TTL_MS;
  return total;
}

function invalidateCachedGalleryCount() {
  galleryCountCacheValue = null;
  galleryCountCacheExpiresAt = 0;
}

// Race any promise against a timeout — prevents Worker hangs.
function withTimeout(promise, ms, label = 'Operation') {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
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
  const { username, password, turnstileToken, hcaptchaToken } = body;

  const USER = env.GALLERY_USER || 'admin';
  const PASS = env.GALLERY_PASS || 'password';
  const SECRET = env.JWT_SECRET || 'change-me';
  const hasTurnstileSecret = Boolean(env.TURNSTILE_SECRET_KEY);
  const hasHCaptchaSecret = Boolean(env.HCAPTCHA_SECRET_KEY);
  const captchaEnabled = hasTurnstileSecret || hasHCaptchaSecret;

  // Verify either captcha provider. One successful verification is enough.
  if (captchaEnabled) {
    const clientIp = request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0] || '';

    const hasCaptchaToken = Boolean(turnstileToken || hcaptchaToken);
    if (!hasCaptchaToken) {
      return jsonResponse({ error: 'Please complete one captcha challenge.' }, 403);
    }
    let isValid = false;
    if (turnstileToken && hasTurnstileSecret) {
      isValid = await verifyTurnstileToken(turnstileToken, clientIp, env.TURNSTILE_SECRET_KEY);
    }
    if (!isValid && hcaptchaToken && hasHCaptchaSecret) {
      isValid = await verifyHCaptchaToken(hcaptchaToken, clientIp, env.HCAPTCHA_SECRET_KEY);
    }
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

  const dbMode = getGalleryDbMode(env);
  if (!dbMode) {
    return jsonResponse({ error: 'No database configured' }, 500);
  }

  if (dbMode === 'd1') {
    if (request.method === 'DELETE') {
      const body = await request.json().catch(() => ({}));
      const id = body?.id;
      if (!id) {
        return jsonResponse({ error: 'Missing id' }, 400);
      }
      try {
        const result = await executeD1(env, `DELETE FROM ${GALLERY_D1_TABLE} WHERE mongo_id = ?`, [id]);
        if (getD1Changes(result) === 1) {
          invalidateCachedGalleryCount();
          return jsonResponse({ ok: true, deletedId: id });
        }
        return jsonResponse({ error: 'Not found' }, 404);
      } catch (e) {
        return jsonResponse({ error: String(e) }, 500);
      }
    }

    const url = new URL(request.url);
    const limitRaw = url.searchParams.get('limit');
    const cursorRaw = url.searchParams.get('cursor');
    const pageRaw = url.searchParams.get('page');
    const pageSizeRaw = url.searchParams.get('pageSize');
    const sortRaw = url.searchParams.get('sort');
    const pageSpanRaw = url.searchParams.get('pageSpan');
    const batchCursorRaw = url.searchParams.get('batchCursor');
    const cursor = typeof cursorRaw === 'string' ? cursorRaw.trim() : '';
    const ascending = sortRaw === 'asc';
    const wantsNumberedPagination = pageRaw !== null || pageSizeRaw !== null;
    const wantsPagination = limitRaw !== null || Boolean(cursor);
    const decodeCursor = (rawCursor) => {
      if (!rawCursor) return null;

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
    const selectColumns = 'mongo_id, prompt, metadata_json, telegram_json, timestamp_iso';
    const orderDirection = ascending ? 'ASC' : 'DESC';
    const compareOperator = ascending ? '>' : '<';

    if (wantsNumberedPagination) {
      const parsedPage = parseInt(String(pageRaw ?? ''), 10);
      const parsedPageSize = parseInt(String(pageSizeRaw ?? ''), 10);
      const parsedPageSpan = parseInt(String(pageSpanRaw ?? ''), 10);
      const pageSize = Number.isFinite(parsedPageSize)
        ? Math.max(1, Math.min(parsedPageSize, 200))
        : 60;
      const pageSpan = Number.isFinite(parsedPageSpan)
        ? Math.max(1, Math.min(parsedPageSpan, GALLERY_MAX_PAGE_SPAN))
        : 1;
      const requestedPage = Number.isFinite(parsedPage)
        ? Math.max(1, parsedPage)
        : 1;

      const totalCount = await getCachedEstimatedGalleryCount(async () => {
        const result = await queryD1(env, `SELECT COUNT(*) AS total FROM ${GALLERY_D1_TABLE}`);
        const row = getD1Rows(result)[0] || null;
        return Number(row?.total || 0);
      });
      const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
      const page = Math.min(requestedPage, totalPages);
      const batchStartPage = Math.floor((page - 1) / pageSpan) * pageSpan + 1;
      const batchEndPage = Math.min(totalPages, batchStartPage + pageSpan - 1);
      const batchLimit = (batchEndPage - batchStartPage + 1) * pageSize;

      const batchCursor = typeof batchCursorRaw === 'string' ? batchCursorRaw.trim() : '';
      let rows;
      if (batchCursor) {
        const cursorValue = decodeCursor(batchCursor);
        const result = await queryD1(
          env,
          `
            SELECT ${selectColumns}
            FROM ${GALLERY_D1_TABLE}
            WHERE timestamp_iso ${compareOperator} ?
            ORDER BY timestamp_iso ${orderDirection}
            LIMIT ?
          `,
          [cursorValue instanceof Date ? cursorValue.toISOString() : cursorValue, batchLimit]
        );
        rows = getD1Rows(result);
      } else {
        const skip = (batchStartPage - 1) * pageSize;
        const result = await queryD1(
          env,
          `
            SELECT ${selectColumns}
            FROM ${GALLERY_D1_TABLE}
            ORDER BY timestamp_iso ${orderDirection}
            LIMIT ? OFFSET ?
          `,
          [batchLimit, skip]
        );
        rows = getD1Rows(result);
      }

      const mappedItems = rows.map(rowToGalleryItem);
      const pages = {};
      for (let p = batchStartPage; p <= batchEndPage; p += 1) {
        const pageOffset = (p - batchStartPage) * pageSize;
        pages[String(p)] = mappedItems.slice(pageOffset, pageOffset + pageSize);
      }
      const items = pages[String(page)] || [];
      const lastRow = rows[rows.length - 1];
      const batchEndCursor = lastRow ? encodeCursor(lastRow.timestamp_iso) : null;

      return jsonResponse(
        {
          items,
          pages,
          page,
          pageSize,
          pageSpan,
          batchStartPage,
          batchEndPage,
          batchEndCursor,
          totalCount,
          totalPages,
          hasMore: page < totalPages,
        },
        200,
        { 'Cache-Control': 'public, max-age=30' }
      );
    }

    if (wantsPagination) {
      const parsedLimit = parseInt(String(limitRaw ?? ''), 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(parsedLimit, 200))
        : 60;

      let whereClause = '';
      const params = [];
      if (cursor) {
        const cursorValue = decodeCursor(cursor);
        whereClause = `WHERE timestamp_iso ${compareOperator} ?`;
        params.push(cursorValue instanceof Date ? cursorValue.toISOString() : cursorValue);
      }

      const result = await queryD1(
        env,
        `
          SELECT ${selectColumns}
          FROM ${GALLERY_D1_TABLE}
          ${whereClause}
          ORDER BY timestamp_iso ${orderDirection}
          LIMIT ?
        `,
        [...params, limit + 1]
      );
      const docs = getD1Rows(result);

      const hasMore = docs.length > limit;
      const pageDocs = hasMore ? docs.slice(0, limit) : docs;
      const items = pageDocs.map(rowToGalleryItem);
      const lastRow = pageDocs[pageDocs.length - 1];
      const nextCursor = hasMore && lastRow
        ? encodeCursor(lastRow.timestamp_iso)
        : null;

      return jsonResponse(
        { items, hasMore, nextCursor, limit },
        200,
        { 'Cache-Control': 'public, max-age=60' }
      );
    }

    const result = await queryD1(
      env,
      `
        SELECT ${selectColumns}
        FROM ${GALLERY_D1_TABLE}
        ORDER BY timestamp_iso DESC
        LIMIT 200
      `
    );
    const docs = getD1Rows(result);

    return jsonResponse(
      docs.map(rowToGalleryItem),
      200,
      { 'Cache-Control': 'public, max-age=60' }
    );
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
          invalidateCachedGalleryCount();
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
    const pageRaw = url.searchParams.get('page');
    const pageSizeRaw = url.searchParams.get('pageSize');
    const sortRaw = url.searchParams.get('sort');
    const pageSpanRaw = url.searchParams.get('pageSpan');
    const batchCursorRaw = url.searchParams.get('batchCursor');
    const cursor = typeof cursorRaw === 'string' ? cursorRaw.trim() : '';
    const ascending = sortRaw === 'asc';
    const wantsNumberedPagination = pageRaw !== null || pageSizeRaw !== null;
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

    // Numbered pagination mode: /api/gallery?page=1&pageSize=60
    if (wantsNumberedPagination) {
      const parsedPage = parseInt(String(pageRaw ?? ''), 10);
      const parsedPageSize = parseInt(String(pageSizeRaw ?? ''), 10);
      const parsedPageSpan = parseInt(String(pageSpanRaw ?? ''), 10);
      const pageSize = Number.isFinite(parsedPageSize)
        ? Math.max(1, Math.min(parsedPageSize, 200))
        : 60;
      const pageSpan = Number.isFinite(parsedPageSpan)
        ? Math.max(1, Math.min(parsedPageSpan, GALLERY_MAX_PAGE_SPAN))
        : 1;
      const requestedPage = Number.isFinite(parsedPage)
        ? Math.max(1, parsedPage)
        : 1;

      const totalCount = await getCachedEstimatedGalleryCount(async () => collection.estimatedDocumentCount());
      const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
      const page = Math.min(requestedPage, totalPages);
      const batchStartPage = Math.floor((page - 1) / pageSpan) * pageSpan + 1;
      const batchEndPage = Math.min(totalPages, batchStartPage + pageSpan - 1);
      const batchLimit = (batchEndPage - batchStartPage + 1) * pageSize;
      const sortDir = ascending ? 1 : -1;

      // If batchCursor is provided, use cursor-based query (avoids O(n) skip).
      // Otherwise fall back to skip() for random page jumps.
      const batchCursor = typeof batchCursorRaw === 'string' ? batchCursorRaw.trim() : '';
      let docs;
      if (batchCursor) {
        const cursorValue = decodeCursor(batchCursor);
        const op = ascending ? '$gt' : '$lt';
        docs = await collection
          .find({ timestamp: { [op]: cursorValue } }, { projection: { prompt: 1, metadata: 1, telegram: 1, timestamp: 1 } })
          .sort({ timestamp: sortDir })
          .limit(batchLimit)
          .toArray();
      } else {
        const skip = (batchStartPage - 1) * pageSize;
        docs = await collection
          .find({}, { projection: { prompt: 1, metadata: 1, telegram: 1, timestamp: 1 } })
          .sort({ timestamp: sortDir })
          .skip(skip)
          .limit(batchLimit)
          .toArray();
      }

      const mappedItems = docs.map(toGalleryItem);
      const pages = {};
      for (let p = batchStartPage; p <= batchEndPage; p += 1) {
        const pageOffset = (p - batchStartPage) * pageSize;
        pages[String(p)] = mappedItems.slice(pageOffset, pageOffset + pageSize);
      }
      const items = pages[String(page)] || [];

      // Provide cursor of the last doc in this batch so the frontend can
      // use cursor-based navigation for the next sequential batch.
      const lastDoc = docs[docs.length - 1];
      const batchEndCursor = lastDoc ? encodeCursor(lastDoc.timestamp) : null;

      return jsonResponse(
        {
          items,
          pages,
          page,
          pageSize,
          pageSpan,
          batchStartPage,
          batchEndPage,
          batchEndCursor,
          totalCount,
          totalPages,
          hasMore: page < totalPages,
        },
        200,
        { 'Cache-Control': 'public, max-age=30' }
      );
    }

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

  // --- Edge cache check ---
  const edgeCache = (request.method === 'GET' && typeof caches !== 'undefined' && caches.default)
    ? caches.default
    : null;
  const edgeCacheKey = edgeCache
    ? new Request(`${url.origin}/__edge_cache/file?file_id=${encodeURIComponent(file_id)}`, { method: 'GET' })
    : null;

  if (edgeCache && edgeCacheKey) {
    const cachedResponse = await edgeCache.match(edgeCacheKey);
    if (cachedResponse) return cachedResponse;
  }

  // --- Resolve metadata (lazy DB fallback) ---
  const filenameHint = url.searchParams.get('filename_hint') || '';
  const hintedExt = extFromFilenameHint(filenameHint);
  const envTokens = [
    ...parseBotTokenList(env.BOT_TOKENS),
    ...parseBotTokenList(env.BOT_TOKEN),
  ];
  let dbMeta = getCachedValue(fileMetaCache, file_id) || null;
  let dbFormat = normalizeExt(dbMeta?.dbFormat) || hintedExt;
  let docId = dbMeta?.docId || null;
  const triedTokens = new Set();

  const readDbMeta = async () => {
    if (dbMeta) return;
    dbMeta = await lookupFileMetaFromDb(env, file_id);
    if (dbMeta) {
      setCachedValue(fileMetaCache, file_id, dbMeta, FILE_META_CACHE_TTL_MS, FILE_META_CACHE_MAX_ITEMS);
      dbFormat = normalizeExt(dbMeta.dbFormat) || hintedExt;
      docId = dbMeta.docId || null;
    }
  };

  // If env has no token configured, load DB meta immediately.
  if (envTokens.length === 0) {
    await readDbMeta();
  }

  const buildCandidateTokens = () => [...new Set([
    ...envTokens,
    dbMeta?.botToken || null,
  ].filter(Boolean))];

  if (buildCandidateTokens().length === 0) {
    return jsonResponse({ error: 'No bot token available' }, 500);
  }

  // --- Helper: build the final image response ---
  function buildImageResponse(imageResp, filePath) {
    const contentType = imageResp.headers.get('content-type') || 'application/octet-stream';
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

  // --- Helper: try to resolve file path and fetch image ---
  async function tryFetch(token) {
    const filePath = await resolveTelegramFilePath(token, file_id);
    if (!filePath) return null;
    const imageUrl = buildUrlFromFilePath(token, filePath);
    const imageResp = await fetchTelegramWithRetry(imageUrl).catch(() => null);
    if (!imageResp || !imageResp.ok) return null;
    return buildImageResponse(imageResp, filePath);
  }

  function commitResponse(response) {
    if (edgeCache && edgeCacheKey) {
      try {
        const putPromise = edgeCache.put(edgeCacheKey, response.clone());
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(putPromise);
        }
      } catch (e) { /* ignore */ }
    }
    return response;
  }

  async function tryTokens(tokens) {
    for (const token of tokens) {
      if (triedTokens.has(token)) continue;
      triedTokens.add(token);
      const response = await tryFetch(token);
      if (response) return response;
    }
    return null;
  }

  let response = await tryTokens(buildCandidateTokens());
  if (response) return commitResponse(response);

  // Only hit MongoDB if env tokens failed.
  if (!dbMeta) {
    await readDbMeta();
    response = await tryTokens(buildCandidateTokens());
    if (response) return commitResponse(response);
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

  const dbMode = getGalleryDbMode(env);
  if (!dbMode) {
    return jsonResponse({ error: 'No database configured' }, 500);
  }

  if (dbMode === 'd1') {
    const result = await queryD1(
      env,
      `
        SELECT mongo_id, prompt, timestamp_iso
        FROM ${GALLERY_D1_TABLE}
        ORDER BY mongo_id DESC
      `
    );
    const docs = getD1Rows(result);

    const THRESHOLD = 0.85;
    const categories = [];

    for (const doc of docs) {
      const tags = parseTags(doc.prompt);
      if (tags.length === 0) continue;
      const tagSet = new Set(tags);
      let matched = false;

      for (const cat of categories) {
        if (jaccardSimilarity(tagSet, cat.tagSet) >= THRESHOLD) {
          cat.items.push(String(doc.mongo_id));
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
          items: [String(doc.mongo_id)],
        });
      }
    }

    const resultCategories = categories.map(({ tagSet, ...rest }) => rest);

    return jsonResponse({
      categories: resultCategories,
      totalItems: docs.length,
      totalCategories: categories.length,
    }, 200, { 'Cache-Control': 'public, max-age=120' });
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

  const dbMode = getGalleryDbMode(env);
  if (!dbMode) {
    return jsonResponse({ error: 'No database configured' }, 500);
  }

  if (dbMode === 'd1') {
    const result = await queryD1(
      env,
      `
        SELECT mongo_id, prompt, metadata_json, telegram_json, timestamp_iso, model
        FROM ${GALLERY_D1_TABLE}
        ORDER BY mongo_id DESC
      `
    );
    const docs = getD1Rows(result);

    const models = {};
    let oldest = null;
    let newest = null;

    const items = docs.map((row) => {
      const item = rowToGalleryItem(row);
      const ts = item.timestamp;
      if (ts) {
        if (!oldest || ts < oldest) oldest = ts;
        if (!newest || ts > newest) newest = ts;
      }
      const model = row.model || item.metadata?.model || 'unknown';
      models[model] = (models[model] || 0) + 1;
      return item;
    });

    return jsonResponse({
      totalItems: docs.length,
      oldestTimestamp: oldest,
      newestTimestamp: newest,
      models,
      items,
    }, 200, { 'Cache-Control': 'public, max-age=60' });
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
    try {
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
        return withTimeout(handleLogin(request, env), 10000, 'Login');
      }
      if (url.pathname === '/api/gallery') {
        return withTimeout(handleGallery(request, env), 25000, 'Gallery');
      }
      if (url.pathname === '/api/gallery/categories') {
        return withTimeout(handleCategories(request, env), 25000, 'Categories');
      }
      if (url.pathname === '/api/gallery/stats') {
        return withTimeout(handleStats(request, env), 25000, 'Stats');
      }
      if (url.pathname === '/api/fileurl') {
        return withTimeout(handleFileUrl(request, env, ctx), 20000, 'FileUrl');
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
          return withTimeout(handleFileUrl(newReq, env, ctx), 20000, 'File');
        }
      }
      if (url.pathname.startsWith('/api/')) {
        return jsonResponse({ error: 'Not Found' }, 404);
      }

      // Non-API routes are handled by the assets (SPA)
      return new Response(null, { status: 404 });
    } catch (e) {
      console.error('Unhandled worker error:', e);
      return jsonResponse({ error: 'Internal Server Error', message: String(e?.message || e) }, 500);
    }
  },
};
