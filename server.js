#!/usr/bin/env node
'use strict';

/**
 * Suno Playlist Player — small Node.js server.
 *
 * Serves index.html and proxies public Suno playlist data. The browser can't
 * call Suno's API directly (no CORS headers), so this server fetches the
 * playlist, normalizes it, and returns a compact JSON payload.
 */

const http = require('node:http');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const webpush = require('web-push');
const { Readable } = require('node:stream');
const { once } = require('node:events');

const ROOT = __dirname;
const INDEX = path.join(ROOT, 'index.html');
const ADMIN_HTML = path.join(ROOT, 'admin.html');
const ABOUT_HTML = path.join(ROOT, 'about.html');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SUNO_TOKEN = process.env.SUNO_TOKEN || '';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '';
const API_BASE = 'https://studio-api.prod.suno.com/api/playlist';
const CLIP_BASE = 'https://studio-api.prod.suno.com/api/clip';
const RIGHTS_URL = 'https://studio-api.prod.suno.com/api/mango/rights';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CLIP_TTL = 10 * 60 * 1000;
const RIGHTS_TTL = 20 * 60 * 1000;
const DOWNLOAD_TOKEN_TTL = 60 * 1000;
const DOWNLOAD_PIN_WINDOW = 5 * 60 * 1000;
const DOWNLOAD_PIN_LOCK = 60 * 1000;
const DOWNLOAD_PIN_MAX_ATTEMPTS = 5;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/* ---------- Admin ---------- */
// Halaman admin tersedia di /nugaduhna. PIN awal bisa diatur lewat environment.
const DEFAULT_ADMIN_PIN = process.env.ADMIN_PIN || '123456';
const DEFAULT_DOWNLOAD_PIN = process.env.DOWNLOAD_PIN || '123456';
const ADMIN_PATH = '/nugaduhna';
const SESSION_COOKIE = 'sp_admin';
const CONFIG_FILE = path.join(ROOT, 'config.json');
const PLAYLISTS_FILE = path.join(ROOT, 'playlists.json');
const COMMENTS_FILE = path.join(ROOT, 'comments.json');
const LIKES_FILE = path.join(ROOT, 'likes.json');
const PLAY_COUNTS_FILE = path.join(ROOT, 'play-counts.json');
const PIN_OVERRIDES_FILE = path.join(ROOT, 'admin-pins.json');
const ADMIN_NOTIFICATIONS_FILE = path.join(ROOT, 'admin-notifications.json');
const PUSH_KEYS_FILE = path.join(ROOT, 'web-push-keys.json');
const PUSH_SUBSCRIPTIONS_FILE = path.join(ROOT, 'push-subscriptions.json');
const MAX_PUSH_SUBSCRIPTIONS = 10000;
const sessions = new Map(); // sessionId -> { at: number }
const downloadTokens = new Map();
const downloadPinAttempts = new Map();
const eventStreams = new Set();
const UUID_STRICT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALL_SONGS_ID = 'all-songs';

const defaultConfig = {
  appName: 'Suno Playlist Player',
  appTag: 'tidak resmi',
  eyebrow: 'Pemutar playlist Suno',
  heroTitle: 'Playlist Suno Anda,<em>siap diputar.</em>',
  heroSub: 'Tambahkan playlist dari panel admin untuk mulai mendengarkan.',
  footer: 'Pemutar tidak resmi. Tidak berafiliasi dengan Suno.',
  themeColor: '#ff6a3d',
  offlineEnabled: true,
  offlineMaxMB: 100,
  offlineClearVersion: 0,
};

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fsSync.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readAppConfig() {
  const config = readJsonFile(CONFIG_FILE, {});
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('App config must contain an object.');
  }
  const merged = { ...defaultConfig, ...config };
  if (typeof merged.offlineEnabled !== 'boolean' ||
      !Number.isInteger(merged.offlineMaxMB) || merged.offlineMaxMB < 16 || merged.offlineMaxMB > 2048 ||
      !Number.isSafeInteger(merged.offlineClearVersion) || merged.offlineClearVersion < 0) {
    throw new Error('App config contains invalid offline cache settings.');
  }
  return merged;
}

function writeJsonFile(file, value) {
  fsSync.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writePrivateJsonFile(file, value) {
  const temporaryFile = `${file}.${process.pid}.tmp`;
  try {
    fsSync.writeFileSync(temporaryFile, JSON.stringify(value, null, 2), { mode: 0o600 });
    fsSync.chmodSync(temporaryFile, 0o600);
    fsSync.renameSync(temporaryFile, file);
  } catch (error) {
    try {
      fsSync.unlinkSync(temporaryFile);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') console.error('Failed to clean up temporary PIN file:', cleanupError);
    }
    throw error;
  }
}

function loadPushKeys() {
  let keys;
  try {
    keys = JSON.parse(fsSync.readFileSync(PUSH_KEYS_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    keys = webpush.generateVAPIDKeys();
    writePrivateJsonFile(PUSH_KEYS_FILE, keys);
  }
  if (!keys || typeof keys.publicKey !== 'string' || typeof keys.privateKey !== 'string') {
    throw new Error('Web Push key file contains invalid data.');
  }
  return keys;
}

const pushKeys = loadPushKeys();
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  pushKeys.publicKey,
  pushKeys.privateKey
);

function readPinOverrides() {
  let overrides;
  try {
    overrides = JSON.parse(fsSync.readFileSync(PIN_OVERRIDES_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Admin PIN file must contain an object.');
  }
  for (const key of ['adminPin', 'downloadPin']) {
    const record = overrides[key];
    if (record !== undefined &&
        (!record || !/^[0-9a-f]{32}$/i.test(record.salt) || !/^[0-9a-f]{128}$/i.test(record.hash))) {
      throw new Error(`Admin PIN file contains an invalid ${key} record.`);
    }
  }
  return overrides;
}

let pinOverrides = readPinOverrides();

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return {
    salt: salt.toString('hex'),
    hash: crypto.scryptSync(pin, salt, 64).toString('hex'),
  };
}

function hashedPinMatches(candidate, record) {
  const salt = Buffer.from(record.salt, 'hex');
  const expected = Buffer.from(record.hash, 'hex');
  const actual = crypto.scryptSync(candidate, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function plainPinMatches(candidate, expected) {
  const provided = Buffer.from(candidate);
  const configured = Buffer.from(expected);
  return provided.length === configured.length && crypto.timingSafeEqual(provided, configured);
}

function adminPinMatches(candidate) {
  if (pinOverrides.adminPin) return hashedPinMatches(candidate, pinOverrides.adminPin);
  return plainPinMatches(candidate, DEFAULT_ADMIN_PIN);
}

function downloadPinMatches(candidate) {
  if (pinOverrides.downloadPin) return hashedPinMatches(candidate, pinOverrides.downloadPin);
  return plainPinMatches(candidate, DEFAULT_DOWNLOAD_PIN || DEFAULT_ADMIN_PIN);
}

function readComments() {
  let contents;
  try {
    contents = fsSync.readFileSync(COMMENTS_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const comments = JSON.parse(contents);
  if (!Array.isArray(comments)) throw new Error('Comments file must contain an array.');
  return comments;
}

function readTrackLikes() {
  const likes = readJsonFile(LIKES_FILE, {});
  if (!likes || typeof likes !== 'object' || Array.isArray(likes)) {
    throw new Error('Likes file must contain an object.');
  }
  return likes;
}

function readPlayCounts() {
  let contents;
  try {
    contents = fsSync.readFileSync(PLAY_COUNTS_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const counts = JSON.parse(contents);
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    throw new Error('Play counts file must contain an object.');
  }
  for (const [trackId, count] of Object.entries(counts)) {
    if (!UUID_STRICT_RE.test(trackId) || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('Play counts file contains invalid data.');
    }
  }
  return counts;
}

function buildAllSongsPlaylist(playlists = readJsonFile(PLAYLISTS_FILE, [])) {
  const uniqueTracks = new Map();
  for (const playlist of Array.isArray(playlists) ? playlists : []) {
    const playlistCreatedAt = playlist?.createdAt || '';
    for (const track of Array.isArray(playlist?.tracks) ? playlist.tracks : []) {
      if (!track || typeof track.id !== 'string' || !track.id) continue;
      const id = track.id.toLowerCase();
      const addedAt = track.addedAt || track.createdAt || playlistCreatedAt;
      const addedTime = Date.parse(addedAt) || 0;
      const current = uniqueTracks.get(id);
      if (!current || addedTime > current.addedTime) {
        uniqueTracks.set(id, {
          ...track,
          id,
          addedAt: Number.isFinite(addedTime) && addedTime ? new Date(addedTime).toISOString() : '',
          addedTime,
        });
      }
    }
  }

  const tracks = [...uniqueTracks.values()].map(({ addedTime, ...track }) => track);
  return {
    id: ALL_SONGS_ID,
    name: 'Semua Lagu',
    description: 'Semua lagu yang ditambahkan admin.',
    image: tracks.find((track) => track.image)?.image || '',
    tracks,
    totalDuration: tracks.reduce((total, track) => total + (Number(track.duration) || 0), 0),
  };
}

function readAdminNotifications() {
  const notifications = readJsonFile(ADMIN_NOTIFICATIONS_FILE, []);
  if (!Array.isArray(notifications)) throw new Error('Admin notifications file must contain an array.');
  return notifications;
}

function normalizePushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return null;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const allowedHost = host === 'fcm.googleapis.com'
    || host === 'web.push.apple.com'
    || host.endsWith('.push.services.mozilla.com')
    || host.endsWith('.notify.windows.com');
  if (url.protocol !== 'https:' || !allowedHost || url.username || url.password || (url.port && url.port !== '443')) {
    return null;
  }
  return url.href;
}

function normalizePushSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object' || Array.isArray(subscription)) return null;
  const endpoint = normalizePushEndpoint(subscription.endpoint);
  const keys = subscription.keys;
  if (!endpoint || !keys || typeof keys !== 'object') return null;
  if (typeof keys.p256dh !== 'string' || !/^[A-Za-z0-9_-]{50,128}$/.test(keys.p256dh)) return null;
  if (typeof keys.auth !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(keys.auth)) return null;
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function readPushSubscriptions() {
  let contents;
  try {
    contents = fsSync.readFileSync(PUSH_SUBSCRIPTIONS_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const subscriptions = JSON.parse(contents);
  if (!Array.isArray(subscriptions) || subscriptions.length > MAX_PUSH_SUBSCRIPTIONS) {
    throw new Error('Push subscriptions file contains invalid data.');
  }
  return subscriptions.map((subscription) => {
    const normalized = normalizePushSubscription(subscription);
    if (!normalized) throw new Error('Push subscriptions file contains invalid data.');
    return normalized;
  });
}

function sameOriginRequest(req) {
  if (!req.headers.origin) return true;
  try {
    const origin = new URL(req.headers.origin);
    const expectedOrigin = PUBLIC_ORIGIN ? new URL(PUBLIC_ORIGIN) : null;
    const requestHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
    return origin.host.toLowerCase() === requestHost ||
      Boolean(expectedOrigin && origin.origin === expectedOrigin.origin);
  } catch {
    return false;
  }
}

function normalizeComment(comment) {
  return {
    ...comment,
    adminLiked: Boolean(comment.adminLiked),
    replies: Array.isArray(comment.replies) ? comment.replies : [],
  };
}

function trackTitleForId(trackId, fallback = '') {
  const playlists = readJsonFile(PLAYLISTS_FILE, []);
  if (Array.isArray(playlists)) {
    for (const playlist of playlists) {
      const track = Array.isArray(playlist.tracks) && playlist.tracks.find((entry) => entry.id === trackId);
      if (track && typeof track.title === 'string') return track.title;
    }
  }
  return fallback || trackId;
}

function broadcastEvent(eventName, payload, audience = 'public') {
  const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of eventStreams) {
    if (client.audience !== audience) continue;
    if (client.res.destroyed || client.res.writableEnded) {
      eventStreams.delete(client);
      continue;
    }
    client.res.write(data);
  }
}

function addAdminNotification(details) {
  const notification = {
    id: crypto.randomUUID(),
    ...details,
    createdAt: new Date().toISOString(),
    readAt: null,
  };
  const notifications = readAdminNotifications();
  notifications.unshift(notification);
  writeJsonFile(ADMIN_NOTIFICATIONS_FILE, notifications.slice(0, 100));
  broadcastEvent('admin-notification', notification, 'admin');
  return notification;
}

async function deliverSongPush(song) {
  const subscriptions = readPushSubscriptions();
  if (!subscriptions.length) return;
  const notificationId = crypto.randomUUID();
  const payload = JSON.stringify({
    title: 'Lagu baru ditambahkan',
    body: `Ditambahkan ${song.title} pada ${song.playlistName}`,
    tag: `song-added-${notificationId}`,
    notificationId,
    url: `/?playlist=${encodeURIComponent(song.playlistId)}&track=${encodeURIComponent(song.trackId)}`,
  });
  const expiredEndpoints = new Set();
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(subscription, payload, { TTL: 86400 });
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        expiredEndpoints.add(subscription.endpoint);
      } else {
        console.error('Push delivery failed:', error.statusCode || error.code || error.name || 'unknown error');
      }
    }
  }));
  if (expiredEndpoints.size) {
    writePrivateJsonFile(
      PUSH_SUBSCRIPTIONS_FILE,
      subscriptions.filter((subscription) => !expiredEndpoints.has(subscription.endpoint))
    );
  }
}

function notifyNewSong(playlist, track) {
  if (!track || !track.id) return;
  const song = {
    trackId: track.id,
    title: track.title || 'Lagu baru',
    playlistId: playlist.id,
    playlistName: playlist.name || 'Playlist',
    songUrl: `https://suno.com/song/${encodeURIComponent(track.id)}`,
    createdAt: new Date().toISOString(),
  };
  broadcastEvent('song-added', song);
  void deliverSongPush(song).catch((error) => {
    console.error('Could not send song push notifications:', error.statusCode || error.code || error.name || 'unknown error');
  });
}

function openEventStream(req, res, audience) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const client = { req, res, audience };
  eventStreams.add(client);
  res.on('close', () => eventStreams.delete(client));
  res.on('error', (err) => {
    console.error('Event stream failed:', err);
    eventStreams.delete(client);
  });
  res.write(': connected\n\n');
}

setInterval(() => {
  for (const client of eventStreams) {
    if (client.audience === 'admin' && !isAdmin(client.req)) {
      client.res.end();
      eventStreams.delete(client);
      continue;
    }
    if (!client.res.destroyed && !client.res.writableEnded) client.res.write(': keep-alive\n\n');
  }
}, 25 * 1000).unref();

function sessionIdOf(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

function isAdmin(req) {
  const id = sessionIdOf(req);
  return Boolean(id && sessions.has(id));
}

function requireAdmin(req, res) {
  if (!isAdmin(req)) {
    sendJson(res, 401, { error: 'Login admin diperlukan.' });
    return false;
  }
  return true;
}

function clearExpiredSessions() {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.at > 7 * 24 * 60 * 60 * 1000) sessions.delete(id);
  }
}
setInterval(clearExpiredSessions, 60 * 60 * 1000).unref();

const cache = new Map();
const clipCache = new Map();
const rightsCache = new Map();

function browserHeaders(extra = {}) {
  return {
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': UA,
    origin: 'https://suno.com',
    referer: 'https://suno.com/',
    ...extra,
  };
}

function sunoHeaders(extra = {}) {
  const headers = browserHeaders(extra);
  if (SUNO_TOKEN) headers.authorization = `Bearer ${SUNO_TOKEN}`;
  return headers;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
    'access-control-allow-origin': '*',
  });
  res.end(data);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function serveFile(res, filePath, contentType, status = 200, cacheControl = 'no-store') {
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': content.length,
      'cache-control': cacheControl,
    });
    res.end(reqMethod(res) === 'HEAD' ? undefined : content);
  } catch {
    sendText(res, 404, 'File not found.');
  }
}

function reqMethod(res) {
  return res.req ? res.req.method : '';
}

function extractPlaylistId(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // A bare UUID.
  if (/^[0-9a-f-]{36}$/i.test(raw)) {
    const m = raw.match(UUID_RE);
    return m ? m[0].toLowerCase() : null;
  }

  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  if (!/(^|\.)suno\.com$/i.test(url.hostname)) return null;

  const match = url.pathname.match(/\/playlist\/([^/?#]+)/i);
  if (!match) return null;
  const id = match[1].match(UUID_RE);
  return id ? id[0].toLowerCase() : null;
}

function extractTrackId(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (/^[0-9a-f-]{36}$/i.test(raw)) {
    const m = raw.match(UUID_RE);
    return m ? m[0].toLowerCase() : null;
  }
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!/(^|\.)suno\.com$/i.test(url.hostname)) return null;
  const match = url.pathname.match(/\/song\/([^/?#]+)/i);
  if (!match) return null;
  const id = match[1].match(UUID_RE);
  return id ? id[0].toLowerCase() : null;
}

function audioScore(media) {
  const type = String(media.content_type || '').toLowerCase();
  let score = 0;
  if (media.delivery === 'progressive') score += 10;
  if (type.includes('m4a') || type.includes('mp4') || type.includes('aac')) score += 6;
  if (type.includes('mp3')) score += 7;
  if (type.includes('wav')) score += 2;
  return score;
}

function pickMedia(clip) {
  const media = Array.isArray(clip.media_urls) ? clip.media_urls.filter((m) => m && m.url) : [];
  if (media.length) {
    const best = [...media].sort((a, b) => audioScore(b) - audioScore(a))[0];
    if (best?.url) return best;
  }

  const direct = typeof clip.audio_url === 'string' ? clip.audio_url : '';
  if (direct && !direct.includes('/api/forbidden')) {
    return { url: direct, content_type: direct.split('?')[0].split('.').pop() || '' };
  }

  return null;
}

/* ---------- Audio decryption ---------- */

// Suno stores new clips as AES-128-CTR encrypted m4a/opus. The key and IV are
// themselves wrapped with AES-256-GCM, using SHA-256(the `glt` JWT) as key.
function unwrapRightsBlob(blob, glt, id) {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < 28) throw new Error('Rights payload is too short.');

  const wrappingKey = crypto.createHash('sha256').update(glt).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]);
}

function ctrAlgorithm(key) {
  if (key.length === 16) return 'aes-128-ctr';
  if (key.length === 24) return 'aes-192-ctr';
  if (key.length === 32) return 'aes-256-ctr';
  throw new Error(`Unsupported key length: ${key.length}`);
}

// AES-CTR treats the IV as a 128-bit big-endian block counter. To decrypt a
// byte range starting mid-file we advance the counter by whole blocks.
function addToCounter(iv, blocks) {
  const max = (1n << 128n) - 1n;
  let value = BigInt(`0x${iv.toString('hex')}`);
  value = (value + BigInt(blocks)) & max;
  return Buffer.from(value.toString(16).padStart(32, '0'), 'hex');
}

function createStreamDecipher(key, iv, start) {
  const block = Math.floor(start / 16);
  return crypto.createDecipheriv(ctrAlgorithm(key), key, addToCounter(iv, block));
}

function decryptBuffer(key, iv, start, end, encrypted) {
  // `encrypted` begins at the start of a cipher block at or before `start`.
  const blockStart = start - (start % 16);
  const decipher = createStreamDecipher(key, iv, blockStart);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plain.subarray(start - blockStart, end - blockStart + 1);
}

function audioContentType(media, upstreamType) {
  const type = String(media.content_type || '').toLowerCase();
  if (type.includes('opus') || type.includes('mp4') || type.includes('m4a')) return 'audio/mp4';
  if (type.includes('webm')) return 'audio/webm';
  if (type.includes('mpeg') || type.includes('mp3')) return 'audio/mpeg';
  if (type.includes('wav')) return 'audio/wav';
  const upstream = String(upstreamType || '').toLowerCase();
  if (upstream.startsWith('audio/')) return upstream;
  return 'audio/mp4';
}

function normalizeTrack(clip, index = 1, image = '') {
  const meta = clip.metadata || {};
  const duration = Number(meta.duration);
  return {
    index,
    id: clip.id,
    title: clip.title || 'Untitled',
    artist: clip.display_name || (clip.handle ? `@${clip.handle}` : 'Unknown artist'),
    handle: clip.handle || '',
    avatar: clip.avatar_image_url || '',
    image: clip.image_large_url || clip.image_url || image,
    audio: `/api/audio/${clip.id}`,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    tags: meta.tags || '',
    prompt: meta.prompt || '',
    model: clip.major_model_version || '',
    modelName: clip.model_name || '',
    createdAt: clip.created_at || '',
    plays: Number(clip.play_count) || 0,
    upvotes: Number(clip.upvote_count) || 0,
    video: clip.video_url || '',
    songUrl: `https://suno.com/song/${clip.id}`,
    explicit: Boolean(clip.explicit),
    instrumental: Boolean(meta.make_instrumental),
  };
}

async function getClip(id) {
  const cached = clipCache.get(id);
  if (cached && cached.expires > Date.now()) return cached.data;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${CLIP_BASE}/${encodeURIComponent(id)}`, {
      headers: sunoHeaders(),
      signal: controller.signal,
    });

    if (response.status === 404) throw httpError(404, 'That track no longer exists on Suno.');
    if (response.status === 401 || response.status === 403) {
      throw httpError(403, 'This track is private. Set SUNO_TOKEN on the server to play it.');
    }
    if (!response.ok) throw httpError(502, `Suno returned an error (${response.status}) for this track.`);

    const clip = await response.json();
    if (!clip || !clip.id) throw httpError(502, 'Suno returned an unexpected clip response.');

    clipCache.set(id, { data: clip, expires: Date.now() + CLIP_TTL });
    return clip;
  } catch (err) {
    if (err.name === 'AbortError') throw httpError(504, 'Suno took too long to return this track.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getRights(id) {
  const cached = rightsCache.get(id);
  if (cached && cached.expires > Date.now()) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(RIGHTS_URL, {
      method: 'POST',
      headers: sunoHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ content_params: { content_id: id, content_type: 'clip' } }),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (!data || !data.key || !data.iv || !data.glt) return null;

    const key = unwrapRightsBlob(data.key, data.glt, id);
    const iv = unwrapRightsBlob(data.iv, data.glt, id);
    if (iv.length !== 16) return null;

    const entry = { key, iv, expires: Date.now() + RIGHTS_TTL };
    rightsCache.set(id, entry);
    return entry;
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || '').trim());
  if (!match) return null;
  const total = match[3] === '*' ? null : Number(match[3]);
  return { start: Number(match[1]), end: Number(match[2]), total };
}

function parseRequestRange(value) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value || '').trim());
  if (!match) return null;
  const start = match[1] === '' ? null : Number(match[1]);
  const end = match[2] === '' ? null : Number(match[2]);
  if (start === null && end === null) return null;
  if (start !== null && end !== null && end < start) return 'invalid';
  return { start, end };
}

async function streamDecrypted(req, res, upstream, key, iv, start, end, total, contentType, extraHeaders = {}) {
  const length = end - start + 1;
  const partial = Boolean(req.headers.range);
  const status = partial ? 206 : 200;
  const headers = {
    'content-type': contentType,
    'content-length': length,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400',
    'access-control-allow-origin': '*',
    ...extraHeaders,
  };
  if (partial) headers['content-range'] = `bytes ${start}-${end}/${total}`;

  if (req.method === 'HEAD') {
    res.writeHead(status, headers);
    res.end();
    return;
  }

  res.writeHead(status, headers);

  const decipher = createStreamDecipher(key, iv, start);
  const skip = start % 16;

  try {
    // The CDN range starts at `start`, but the cipher stream starts at the
    // previous block boundary. Burn the leading keystream bytes.
    if (skip > 0) decipher.update(Buffer.alloc(skip));

    for await (const chunk of Readable.fromWeb(upstream.body)) {
      const out = decipher.update(chunk);
      if (out.length && !res.write(out)) await once(res, 'drain');
    }

    const tail = decipher.final();
    if (tail.length) res.end(tail);
    else res.end();
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'Could not decrypt this track.' });
    } else {
      res.destroy(err);
    }
  }
}

function audioContentDisposition(title) {
  const cleanTitle = String(title || 'audio').replace(/[\u0000-\u001f\u007f"\\/]/g, '_').slice(0, 120) || 'audio';
  const filename = `${cleanTitle}.m4a`;
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function serveAudio(req, res, id, { download = false } = {}) {
  if (!UUID_RE.test(id)) {
    sendJson(res, 400, { error: 'Invalid track id.' });
    return;
  }

  const clip = await getClip(id);
  const media = pickMedia(clip);
  if (!media) throw httpError(404, 'This track has no audio available.');
  const downloadHeaders = download
    ? {
        'content-disposition': audioContentDisposition(clip.title),
        'cache-control': 'no-store',
      }
    : {};

  const rights = await getRights(id);
  if (!rights) {
    const offlineRequest = new URL(req.url, 'http://localhost').searchParams.get('offline') === '1';
    const looksEncrypted = /opus|m4a|mp4/i.test(String(media.content_type || ''));
    if (looksEncrypted) {
      throw httpError(502, 'Suno did not provide a playback key for this track. Try again shortly.');
    }
    if (!download && !offlineRequest) {
      res.writeHead(302, { location: media.url, 'cache-control': 'no-store' });
      res.end();
      return;
    }

    const requestHeaders = {
      'user-agent': UA,
      referer: 'https://suno.com/',
    };
    if (req.headers.range) requestHeaders.range = req.headers.range;
    const upstream = await fetch(media.url, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: requestHeaders,
    });
    if (!upstream.ok && upstream.status !== 206) {
      throw httpError(502, `Suno's audio CDN returned an error (${upstream.status}).`);
    }
    const headers = {
      ...downloadHeaders,
      'content-type': audioContentType(media, upstream.headers.get('content-type')),
      'cache-control': 'no-store',
      'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes',
    };
    for (const header of ['content-length', 'content-range']) {
      const value = upstream.headers.get(header);
      if (value) headers[header] = value;
    }
    res.writeHead(upstream.status, headers);
    if (req.method === 'HEAD' || !upstream.body) {
      res.end();
      return;
    }
    const body = Readable.fromWeb(upstream.body);
    body.on('error', (err) => {
      if (res.headersSent) res.destroy(err);
      else sendJson(res, 502, { error: 'Could not download this track.' });
    });
    body.pipe(res);
    return;
  }

  if (req.method === 'HEAD') {
    const head = await fetch(media.url, {
      method: 'HEAD',
      headers: { 'user-agent': UA, referer: 'https://suno.com/' },
    });
    const total = Number(head.headers.get('content-length'));
    const headers = {
      'content-type': audioContentType(media, head.headers.get('content-type')),
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=86400',
      'access-control-allow-origin': '*',
      ...downloadHeaders,
    };
    if (Number.isFinite(total) && total > 0) headers['content-length'] = total;
    res.writeHead(head.ok ? 200 : 502, headers);
    res.end();
    return;
  }

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const headers = {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': UA,
    referer: 'https://suno.com/',
  };
  const requested = parseRequestRange(req.headers.range);
  if (requested === 'invalid') {
    res.writeHead(416, { 'content-range': 'bytes */*' });
    res.end();
    return;
  }
  if (requested && req.headers.range) headers.range = req.headers.range;

  const upstream = await fetch(media.url, { headers, signal: controller.signal });

  if (upstream.status === 416) {
    res.writeHead(416, {
      'content-range': upstream.headers.get('content-range') || 'bytes */*',
      'accept-ranges': 'bytes',
    });
    res.end();
    return;
  }

  if (!upstream.ok && upstream.status !== 206) {
    throw httpError(502, `Suno's audio CDN returned an error (${upstream.status}).`);
  }

  const contentType = audioContentType(media, upstream.headers.get('content-type'));

  if (upstream.status === 206) {
    const range = parseContentRange(upstream.headers.get('content-range'));
    if (!range || range.total === null) {
      throw httpError(502, 'Suno returned an invalid audio range.');
    }
    await streamDecrypted(
      req,
      res,
      upstream,
      rights.key,
      rights.iv,
      range.start,
      range.end,
      range.total,
      contentType,
      downloadHeaders
    );
    return;
  }

  // CDN ignored the range request (rare). Buffer it and slice locally.
  const total = Number(upstream.headers.get('content-length'));
  if (!Number.isFinite(total) || total <= 0) throw httpError(502, 'Suno returned audio with no length.');

  if (requested) {
    const start = requested.start === null ? Math.max(0, total - Number(requested.end)) : requested.start;
    const end = requested.start === null ? total - 1 : Math.min(requested.end ?? total - 1, total - 1);
    if (start >= total || end < start) {
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      res.end();
      return;
    }

    const whole = Buffer.from(await upstream.arrayBuffer());
    if (whole.length !== total) throw httpError(502, 'Suno returned a truncated audio file.');
    const blockStart = start - (start % 16);
    const plain = decryptBuffer(rights.key, rights.iv, start, end, whole.subarray(blockStart, end + 1));

    res.writeHead(206, {
      'content-type': contentType,
      'content-length': plain.length,
      'content-range': `bytes ${start}-${end}/${total}`,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=86400',
      'access-control-allow-origin': '*',
      ...downloadHeaders,
    });
    res.end(req.method === 'HEAD' ? undefined : plain);
    return;
  }

  await streamDecrypted(
    req,
    res,
    upstream,
    rights.key,
    rights.iv,
    0,
    total - 1,
    total,
    contentType,
    downloadHeaders
  );
}

function normalizePlaylist(raw) {
  const clips = (Array.isArray(raw.playlist_clips) ? raw.playlist_clips : [])
    .map((entry) => (entry && entry.clip ? entry.clip : entry))
    .filter((clip) => clip && clip.id);

  const tracks = clips.map((clip, index) => normalizeTrack(clip, index + 1, raw.image_url || ''));

  const fallbackDuration = tracks.reduce((sum, track) => sum + track.duration, 0);
  const totalDuration = Number(raw.total_duration);

  return {
    id: raw.id,
    name: raw.name || 'Untitled playlist',
    description: raw.description || '',
    image: raw.image_url || '',
    creator: {
      name: raw.user_display_name || 'Suno',
      handle: raw.user_handle || '',
      avatar: raw.user_avatar_image_url || '',
      verified: Boolean(raw.user_is_verified),
    },
    isPublic: raw.is_public !== false,
    plays: Number(raw.play_count) || 0,
    upvotes: Number(raw.upvote_count) || 0,
    totalDuration: Number.isFinite(totalDuration) && totalDuration > 0 ? totalDuration : fallbackDuration,
    sourceUrl: `https://suno.com/playlist/${raw.id}`,
    fetchedAt: new Date().toISOString(),
    tracks,
  };
}

async function fetchPlaylist(id) {
  const cached = cache.get(id);
  if (cached && cached.expires > Date.now()) return cached.data;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, {
      headers: sunoHeaders(),
      redirect: 'follow',
      signal: controller.signal,
    });

    if (response.status === 404) {
      throw httpError(404, 'Playlist not found. It may be private, deleted, or the link is wrong.');
    }
    if (response.status === 401 || response.status === 403) {
      throw httpError(
        403,
        'This playlist is private. Set a SUNO_TOKEN environment variable on the server to access it.'
      );
    }
    if (!response.ok) {
      throw httpError(502, `Suno returned an error (${response.status}). Try again in a moment.`);
    }

    const raw = await response.json();
    if (!raw || !raw.id) throw httpError(502, 'Suno returned an unexpected response.');

    const data = normalizePlaylist(raw);
    cache.set(id, { data, expires: Date.now() + CACHE_TTL });
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw httpError(504, 'Suno took too long to respond. Try again.');
    }
    if (err.status) throw err;
    throw httpError(502, 'Could not reach Suno. Check your internet connection and try again.');
  } finally {
    clearTimeout(timer);
  }
}

function makeSession() {
  const id = crypto.randomBytes(16).toString('hex');
  sessions.set(id, { at: Date.now() });
  return id;
}

function setSessionCookie(res, sessionId, clear = false) {
  if (clear) {
    res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    return;
  }
  res.setHeader('set-cookie', `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax`);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readLimitedBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooLarge) reject(httpError(413, 'Komentar terlalu besar.'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function handlePushSubscriptions(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  if (!sameOriginRequest(req)) {
    sendJson(res, 403, { error: 'Permintaan notifikasi harus berasal dari situs ini.' });
    return;
  }

  let body;
  try {
    body = JSON.parse((await readLimitedBody(req, 8192)).toString('utf8') || '{}');
  } catch (error) {
    const status = error.status === 413 ? 413 : 400;
    sendJson(res, status, {
      error: status === 413 ? 'Data langganan notifikasi terlalu besar.' : 'Data langganan notifikasi tidak valid.',
    });
    return;
  }

  if (req.method === 'POST') {
    const subscription = normalizePushSubscription(body);
    if (!subscription) {
      sendJson(res, 400, { error: 'Langganan push tidak valid.' });
      return;
    }
    const subscriptions = readPushSubscriptions();
    const existingIndex = subscriptions.findIndex((item) => item.endpoint === subscription.endpoint);
    if (existingIndex === -1 && subscriptions.length >= MAX_PUSH_SUBSCRIPTIONS) {
      sendJson(res, 429, { error: 'Jumlah langganan notifikasi sudah mencapai batas.' });
      return;
    }
    if (existingIndex === -1) subscriptions.push(subscription);
    else subscriptions[existingIndex] = subscription;
    writePrivateJsonFile(PUSH_SUBSCRIPTIONS_FILE, subscriptions);
    sendJson(res, 201, { ok: true });
    return;
  }

  const endpoint = normalizePushEndpoint(body?.endpoint);
  if (!endpoint) {
    sendJson(res, 400, { error: 'Alamat langganan push tidak valid.' });
    return;
  }
  const subscriptions = readPushSubscriptions();
  const remaining = subscriptions.filter((subscription) => subscription.endpoint !== endpoint);
  if (remaining.length !== subscriptions.length) {
    writePrivateJsonFile(PUSH_SUBSCRIPTIONS_FILE, remaining);
  }
  sendJson(res, 200, { ok: true });
}

async function handleComments(req, res, trackId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trackId)) {
    sendJson(res, 400, { error: 'ID lagu tidak valid.' });
    return;
  }

  if (req.method === 'GET') {
    const comments = readComments()
      .filter((comment) => comment.trackId === trackId)
      .map(normalizeComment);
    sendJson(res, 200, comments);
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readLimitedBody(req, 4096) || '{}');
  } catch (err) {
    const status = err.status || 400;
    sendJson(res, status, { error: status === 413 ? err.message : 'Body komentar tidak valid.' });
    return;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'Body komentar tidak valid.' });
    return;
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!text || text.length > 1000) {
    sendJson(res, 400, { error: 'Komentar wajib diisi dan maksimal 1000 karakter.' });
    return;
  }
  if (name.length > 60) {
    sendJson(res, 400, { error: 'Nama maksimal 60 karakter.' });
    return;
  }

  const suppliedTrackTitle = typeof body.trackTitle === 'string' ? body.trackTitle.trim().slice(0, 160) : '';
  const comment = {
    id: crypto.randomUUID(),
    trackId: trackId.toLowerCase(),
    name,
    text,
    trackTitle: trackTitleForId(trackId.toLowerCase(), suppliedTrackTitle),
    createdAt: new Date().toISOString(),
    adminLiked: false,
    replies: [],
  };
  const comments = readComments();
  comments.push(comment);
  writeJsonFile(COMMENTS_FILE, comments);
  addAdminNotification({
    type: 'comment',
    trackId: comment.trackId,
    commentId: comment.id,
    trackTitle: comment.trackTitle,
    summary: `${comment.name || 'Pengunjung'}: ${comment.text.slice(0, 160)}`,
  });
  broadcastEvent('comments-updated', { trackId: comment.trackId });
  sendJson(res, 201, comment);
}

async function handleTrackLikes(req, res, url, trackId = '') {
  if (trackId && !UUID_STRICT_RE.test(trackId)) {
    sendJson(res, 400, { error: 'ID lagu tidak valid.' });
    return;
  }

  if (req.method === 'GET' && !trackId) {
    const clientId = url.searchParams.get('clientId') || '';
    if (clientId && !UUID_STRICT_RE.test(clientId)) {
      sendJson(res, 400, { error: 'ID pengunjung tidak valid.' });
      return;
    }
    const storedLikes = readTrackLikes();
    const result = {};
    for (const [id, voters] of Object.entries(storedLikes)) {
      if (!UUID_STRICT_RE.test(id) || !Array.isArray(voters)) continue;
      result[id] = {
        count: voters.length,
        liked: Boolean(clientId && voters.includes(clientId)),
      };
    }
    sendJson(res, 200, result);
    return;
  }

  if (req.method !== 'POST' || !trackId) {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readLimitedBody(req, 2048) || '{}');
  } catch (err) {
    const status = err.status || 400;
    sendJson(res, status, { error: status === 413 ? err.message : 'Permintaan suka tidak valid.' });
    return;
  }
  const clientId = body && typeof body.clientId === 'string' ? body.clientId : '';
  if (!UUID_STRICT_RE.test(clientId)) {
    sendJson(res, 400, { error: 'ID pengunjung tidak valid.' });
    return;
  }

  const id = trackId.toLowerCase();
  const storedLikes = readTrackLikes();
  const voters = new Set(Array.isArray(storedLikes[id]) ? storedLikes[id] : []);
  const liked = !voters.has(clientId);
  if (liked) voters.add(clientId);
  else voters.delete(clientId);
  storedLikes[id] = [...voters];
  writeJsonFile(LIKES_FILE, storedLikes);

  const count = voters.size;
  if (liked) {
    const suppliedTitle = typeof body.trackTitle === 'string' ? body.trackTitle.trim().slice(0, 160) : '';
    addAdminNotification({
      type: 'like',
      trackId: id,
      trackTitle: trackTitleForId(id, suppliedTitle),
      summary: 'Pengunjung menyukai lagu ini.',
    });
  }
  broadcastEvent('track-like-updated', { trackId: id, count });
  sendJson(res, 200, { count, liked });
}

function handlePlayCounts(req, res, trackId = '') {
  if (!trackId && req.method === 'GET') {
    sendJson(res, 200, readPlayCounts());
    return;
  }
  if (!trackId || !UUID_STRICT_RE.test(trackId)) {
    sendJson(res, 400, { error: 'ID lagu tidak valid.' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const id = trackId.toLowerCase();
  const counts = readPlayCounts();
  const currentCount = counts[id] || 0;
  if (currentCount >= Number.MAX_SAFE_INTEGER) {
    sendJson(res, 409, { error: 'Jumlah pemutaran sudah mencapai batas.' });
    return;
  }
  counts[id] = currentCount + 1;
  writeJsonFile(PLAY_COUNTS_FILE, counts);
  broadcastEvent('play-count-updated', { trackId: id, count: counts[id] });
  sendJson(res, 200, { trackId: id, count: counts[id] });
}

async function handleDownload(req, res, url, trackId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trackId)) {
    sendJson(res, 400, { error: 'ID lagu tidak valid.' });
    return;
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readLimitedBody(req, 2048) || '{}');
    } catch (err) {
      const status = err.status || 400;
      sendJson(res, status, { error: status === 413 ? 'Permintaan terlalu besar.' : 'Permintaan tidak valid.' });
      return;
    }

    const clientIp = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown')
      .split(',')[0]
      .trim()
      .slice(0, 128);
    const now = Date.now();
    let attempt = downloadPinAttempts.get(clientIp);
    if (attempt?.lockedUntil > now) {
      res.setHeader('retry-after', String(Math.ceil((attempt.lockedUntil - now) / 1000)));
      sendJson(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi sebentar.' });
      return;
    }
    if (attempt && (attempt.lockedUntil || now - attempt.startedAt >= DOWNLOAD_PIN_WINDOW)) {
      downloadPinAttempts.delete(clientIp);
      attempt = null;
    }

    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        typeof body.pin !== 'string' || !downloadPinMatches(body.pin)) {
      attempt = attempt || { startedAt: now, failures: 0 };
      attempt.failures += 1;
      if (attempt.failures >= DOWNLOAD_PIN_MAX_ATTEMPTS) {
        attempt.lockedUntil = now + DOWNLOAD_PIN_LOCK;
      }
      downloadPinAttempts.set(clientIp, attempt);
      sendJson(res, 401, { error: 'PIN salah.' });
      return;
    }

    downloadPinAttempts.delete(clientIp);
    const token = crypto.randomBytes(24).toString('base64url');
    downloadTokens.set(token, {
      trackId: trackId.toLowerCase(),
      expires: now + DOWNLOAD_TOKEN_TTL,
    });
    sendJson(res, 200, { url: `/api/download/${trackId}?token=${token}` });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const token = url.searchParams.get('token') || '';
    const grant = downloadTokens.get(token);
    if (!grant || grant.trackId !== trackId.toLowerCase() || grant.expires <= Date.now()) {
      sendJson(res, 401, { error: 'PIN unduh diperlukan atau sudah kedaluwarsa.' });
      return;
    }
    await serveAudio(req, res, trackId, { download: true });
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed.' });
}

async function handleAdminLogin(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req) || '{}');
  } catch {
    sendJson(res, 400, { error: 'Body tidak valid.' });
    return;
  }
  if (body && typeof body.pin === 'string' && adminPinMatches(body.pin)) {
    const sid = makeSession();
    setSessionCookie(res, sid);
    sendJson(res, 200, { ok: true, redirect: ADMIN_PATH });
  } else {
    sendJson(res, 401, { error: 'PIN salah.' });
  }
}

async function handleAdminLogout(req, res) {
  const sessionId = sessionIdOf(req);
  if (sessionId) sessions.delete(sessionId);
  setSessionCookie(res, null, true);
  sendJson(res, 200, { ok: true });
}

async function handleAdminApi(req, res, url) {
  const segments = url.pathname.slice('/api/admin/'.length).split('/').filter(Boolean);
  const resource = segments[0];
  const id = segments[1];
  const sub = segments[2];

  if (req.method === 'GET') {
    if (resource === 'config') {
      sendJson(res, 200, readAppConfig());
      return;
    }
    if (resource === 'playlists') {
      sendJson(res, 200, readJsonFile(PLAYLISTS_FILE, []));
      return;
    }
    if (resource === 'comments') {
      const comments = readComments()
        .map((comment) => {
          const normalized = normalizeComment(comment);
          return {
            ...normalized,
            trackTitle: trackTitleForId(normalized.trackId, normalized.trackTitle || normalized.trackId),
          };
        })
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      sendJson(res, 200, comments);
      return;
    }
    if (resource === 'notifications') {
      sendJson(res, 200, readAdminNotifications().slice(0, 100));
      return;
    }
    sendJson(res, 404, { error: 'Endpoint tidak diketahui.' });
    return;
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req) || '{}');
    } catch {
      sendJson(res, 400, { error: 'Body tidak valid.' });
      return;
    }

    if (resource === 'pins') {
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'Body PIN tidak valid.' });
        return;
      }
      const hasAdminPin = Object.prototype.hasOwnProperty.call(body, 'adminPin');
      const hasDownloadPin = Object.prototype.hasOwnProperty.call(body, 'downloadPin');
      if (!hasAdminPin && !hasDownloadPin) {
        sendJson(res, 400, { error: 'Masukkan PIN yang ingin diubah.' });
        return;
      }
      for (const key of ['adminPin', 'downloadPin']) {
        if (Object.prototype.hasOwnProperty.call(body, key) &&
            (typeof body[key] !== 'string' || !/^[0-9]{4,10}$/.test(body[key]))) {
          sendJson(res, 400, { error: 'PIN harus terdiri dari 4 sampai 10 digit.' });
          return;
        }
      }

      const next = { ...pinOverrides };
      if (hasAdminPin) {
        next.adminPin = hashPin(body.adminPin);
        if (!hasDownloadPin && !pinOverrides.downloadPin && !DEFAULT_DOWNLOAD_PIN) {
          next.downloadPin = hashPin(body.adminPin);
        }
      }
      if (hasDownloadPin) next.downloadPin = hashPin(body.downloadPin);
      writePrivateJsonFile(PIN_OVERRIDES_FILE, next);
      pinOverrides = next;
      sendJson(res, 200, { ok: true });
      return;
    }

    if (resource === 'notifications' && id === 'read') {
      const readAt = new Date().toISOString();
      const notifications = readAdminNotifications().map((notification) =>
        notification.readAt ? notification : { ...notification, readAt }
      );
      writeJsonFile(ADMIN_NOTIFICATIONS_FILE, notifications);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (resource === 'comments' && id && sub === 'like') {
      const comments = readComments();
      const index = comments.findIndex((comment) => comment.id === id);
      if (index === -1) {
        sendJson(res, 404, { error: 'Komentar tidak ditemukan.' });
        return;
      }
      comments[index] = normalizeComment(comments[index]);
      comments[index].adminLiked = !comments[index].adminLiked;
      comments[index].adminLikedAt = comments[index].adminLiked ? new Date().toISOString() : null;
      writeJsonFile(COMMENTS_FILE, comments);
      broadcastEvent('comments-updated', { trackId: comments[index].trackId });
      sendJson(res, 200, { adminLiked: comments[index].adminLiked });
      return;
    }

    if (resource === 'comments' && id && sub === 'reply') {
      const text = body && typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 1000) {
        sendJson(res, 400, { error: 'Balasan wajib diisi dan maksimal 1000 karakter.' });
        return;
      }
      const comments = readComments();
      const index = comments.findIndex((comment) => comment.id === id);
      if (index === -1) {
        sendJson(res, 404, { error: 'Komentar tidak ditemukan.' });
        return;
      }
      comments[index] = normalizeComment(comments[index]);
      const reply = {
        id: crypto.randomUUID(),
        name: 'Admin',
        text,
        createdAt: new Date().toISOString(),
      };
      comments[index].replies.push(reply);
      writeJsonFile(COMMENTS_FILE, comments);
      broadcastEvent('comments-updated', { trackId: comments[index].trackId });
      sendJson(res, 201, reply);
      return;
    }

    if (resource === 'config') {
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'Body konfigurasi tidak valid.' });
        return;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'offlineEnabled') &&
          typeof body.offlineEnabled !== 'boolean') {
        sendJson(res, 400, { error: 'Pengaturan cache offline tidak valid.' });
        return;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'offlineMaxMB') &&
          (!Number.isInteger(body.offlineMaxMB) || body.offlineMaxMB < 16 || body.offlineMaxMB > 2048)) {
        sendJson(res, 400, { error: 'Batas cache lagu harus antara 16 dan 2048 MB.' });
        return;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'themeColor') &&
          (typeof body.themeColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(body.themeColor))) {
        sendJson(res, 400, { error: 'Warna tema harus berupa kode HEX 6 digit.' });
        return;
      }
      const current = readAppConfig();
      const config = { ...current, ...body, offlineClearVersion: current.offlineClearVersion };
      writeJsonFile(CONFIG_FILE, config);
      broadcastEvent('app-config-updated', config);
      sendJson(res, 200, config);
      return;
    }

    if (resource === 'offline-cache' && id === 'clear') {
      const config = readAppConfig();
      config.offlineClearVersion += 1;
      writeJsonFile(CONFIG_FILE, config);
      broadcastEvent('app-config-updated', config);
      sendJson(res, 200, { offlineClearVersion: config.offlineClearVersion });
      return;
    }

    if (resource === 'playlists' && id && sub === 'tracks') {
      const playlists = readJsonFile(PLAYLISTS_FILE, []);
      const index = playlists.findIndex((p) => p.id === id);
      if (index === -1) {
        sendJson(res, 404, { error: 'Playlist tidak ditemukan.' });
        return;
      }

      // Dua cara menambah lagu:
      // 1) Kirim URL/ID lagu Suno (body.suno) -> server mengambil detail dari Suno.
      // 2) Isi manual (title/artist/audio) untuk audio dari URL lain.
      let track;
      const sunoId = extractTrackId(body.suno || body.sunoUrl || body.url || '');
      if (sunoId) {
        try {
          const clip = await getClip(sunoId);
          const normalized = normalizeTrack(clip);
          track = {
            ...normalized,
            id: normalized.id,
            createdAt: normalized.createdAt || new Date().toISOString(),
            addedAt: new Date().toISOString(),
          };
        } catch (err) {
          const status = err.status || 502;
          sendJson(res, status, { error: err.message || 'Gagal mengambil lagu dari Suno.' });
          return;
        }
      } else {
        const addedAt = new Date().toISOString();
        track = {
          id: crypto.randomUUID(),
          title: body.title || 'Untitled',
          artist: body.artist || 'Unknown',
          audio: body.audio || '',
          image: body.image || '',
          duration: Number(body.duration) || 0,
          tags: body.tags || '',
          prompt: body.prompt || '',
          createdAt: addedAt,
          addedAt,
        };
      }

      playlists[index].tracks = Array.isArray(playlists[index].tracks) ? playlists[index].tracks : [];
      playlists[index].tracks.push(track);
      writeJsonFile(PLAYLISTS_FILE, playlists);
      notifyNewSong(playlists[index], track);
      sendJson(res, 201, track);
      return;
    }

    if (resource === 'playlists') {
      if (body.id === ALL_SONGS_ID) {
        sendJson(res, 400, { error: 'ID playlist tersebut sudah digunakan.' });
        return;
      }
      const playlists = readJsonFile(PLAYLISTS_FILE, []);
      const addedAt = new Date().toISOString();
      const entry = {
        id: body.id || crypto.randomUUID(),
        name: body.name || 'Playlist baru',
        description: body.description || '',
        image: body.image || '',
        tracks: Array.isArray(body.tracks)
          ? body.tracks.map((track) => ({
              ...track,
              addedAt: track?.addedAt || addedAt,
            }))
          : [],
        createdAt: body.createdAt || addedAt,
      };
      playlists.push(entry);
      writeJsonFile(PLAYLISTS_FILE, playlists);
      entry.tracks.forEach((track) => notifyNewSong(entry, track));
      sendJson(res, 201, entry);
      return;
    }

    sendJson(res, 404, { error: 'Endpoint tidak diketahui.' });
    return;
  }

  if (req.method === 'PUT' && resource === 'playlists' && id) {
    let body;
    try {
      body = JSON.parse(await readBody(req) || '{}');
    } catch {
      sendJson(res, 400, { error: 'Body tidak valid.' });
      return;
    }
    const playlists = readJsonFile(PLAYLISTS_FILE, []);
    const index = playlists.findIndex((p) => p.id === id);
    if (index === -1) {
      sendJson(res, 404, { error: 'Playlist tidak ditemukan.' });
      return;
    }
    playlists[index] = { ...playlists[index], ...body, id };
    writeJsonFile(PLAYLISTS_FILE, playlists);
    sendJson(res, 200, playlists[index]);
    return;
  }

  if (req.method === 'DELETE') {
    if (resource === 'comments' && id && !sub) {
      const comments = readComments();
      const index = comments.findIndex((comment) => comment.id === id);
      if (index === -1) {
        sendJson(res, 404, { error: 'Komentar tidak ditemukan.' });
        return;
      }
      const [deleted] = comments.splice(index, 1);
      writeJsonFile(COMMENTS_FILE, comments);
      broadcastEvent('comments-updated', { trackId: deleted.trackId });
      sendJson(res, 200, { ok: true });
      return;
    }
    const playlists = readJsonFile(PLAYLISTS_FILE, []);
    if (resource === 'playlists' && id && !sub) {
      const filtered = playlists.filter((p) => p.id !== id);
      writeJsonFile(PLAYLISTS_FILE, filtered);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (resource === 'playlists' && id && sub === 'tracks' && segments[3]) {
      const index = playlists.findIndex((p) => p.id === id);
      if (index === -1) {
        sendJson(res, 404, { error: 'Playlist tidak ditemukan.' });
        return;
      }
      playlists[index].tracks = (playlists[index].tracks || []).filter((t) => t.id !== segments[3]);
      writeJsonFile(PLAYLISTS_FILE, playlists);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: 'Endpoint tidak diketahui.' });
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed.' });
}

async function serveIndex(res, req) {
  try {
    const html = await fs.readFile(INDEX);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'content-length': html.length,
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  } catch {
    sendText(res, 500, 'index.html is missing. Run the server from the project folder.');
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendText(res, 400, 'Bad request.');
    return;
  }

  if (!['GET','HEAD','POST','PUT','DELETE'].includes(req.method)) {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  try {
    if (url.pathname === '/service-worker.js' || url.pathname === '/push-client.js') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'Method not allowed.' });
        return;
      }
      const file = url.pathname === '/service-worker.js'
        ? path.join(ROOT, 'service-worker.js')
        : path.join(ROOT, 'push-client.js');
      await serveFile(res, file, 'application/javascript; charset=utf-8');
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      await serveIndex(res, req);
      return;
    }

    if (url.pathname === '/about' || url.pathname === '/about/') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'Method not allowed.' });
        return;
      }
      await serveFile(res, ABOUT_HTML, 'text/html; charset=utf-8');
      return;
    }

    // ---------- Admin halaman: /nugaduhna ----------
    if (url.pathname === ADMIN_PATH || url.pathname.startsWith(`${ADMIN_PATH}/`)) {
      if (req.method === 'POST' && url.pathname === `${ADMIN_PATH}/login`) {
        await handleAdminLogin(req, res);
        return;
      }
      if (req.method === 'POST' && url.pathname === `${ADMIN_PATH}/logout`) {
        await handleAdminLogout(req, res);
        return;
      }
      // Halaman login sendiri tidak perlu autentikasi (JS akan menampilkan view yang sesuai).
      if (url.pathname === `${ADMIN_PATH}/login`) {
        await serveFile(res, ADMIN_HTML, 'text/html; charset=utf-8', 200);
        return;
      }
      if (!isAdmin(req)) {
        const next = url.pathname === `${ADMIN_PATH}/comments` ? '?next=comments' : '';
        res.writeHead(302, { location: `${ADMIN_PATH}/login${next}`, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      await serveFile(res, ADMIN_HTML, 'text/html; charset=utf-8', 200);
      return;
    }

    if (url.pathname === '/api/admin/events') {
      if (!requireAdmin(req, res)) return;
      openEventStream(req, res, 'admin');
      return;
    }

    // ---------- Admin API ----------
    if (url.pathname.startsWith('/api/admin/')) {
      if (!requireAdmin(req, res)) return;
      await handleAdminApi(req, res, url);
      return;
    }

    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, hasToken: Boolean(SUNO_TOKEN) });
      return;
    }

    if (url.pathname === '/api/events') {
      openEventStream(req, res, 'public');
      return;
    }

    if (url.pathname === '/api/push/public-key') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed.' });
        return;
      }
      sendJson(res, 200, { publicKey: pushKeys.publicKey });
      return;
    }

    if (url.pathname === '/api/push/subscriptions') {
      await handlePushSubscriptions(req, res);
      return;
    }

    if (url.pathname.startsWith('/api/comments/')) {
      const trackId = decodeURIComponent(url.pathname.slice('/api/comments/'.length));
      await handleComments(req, res, trackId);
      return;
    }

    if (url.pathname === '/api/likes' || url.pathname.startsWith('/api/likes/')) {
      const trackId = url.pathname === '/api/likes'
        ? ''
        : decodeURIComponent(url.pathname.slice('/api/likes/'.length));
      await handleTrackLikes(req, res, url, trackId);
      return;
    }

    if (url.pathname === '/api/play-counts' || url.pathname.startsWith('/api/play-counts/')) {
      const trackId = url.pathname === '/api/play-counts'
        ? ''
        : decodeURIComponent(url.pathname.slice('/api/play-counts/'.length));
      handlePlayCounts(req, res, trackId);
      return;
    }

    if (url.pathname.startsWith('/api/download/')) {
      const trackId = decodeURIComponent(url.pathname.slice('/api/download/'.length));
      await handleDownload(req, res, url, trackId);
      return;
    }

    // ---------- Publik: konfigurasi aplikasi ----------
    if (url.pathname === '/api/config') {
      sendJson(res, 200, readAppConfig());
      return;
    }

    // ---------- Publik: daftar playlist hasil kurasi admin ----------
    if (url.pathname === '/api/playlists') {
      const playlists = readJsonFile(PLAYLISTS_FILE, []);
      const allSongs = buildAllSongsPlaylist(playlists);
      sendJson(res, 200, [
        { ...allSongs, tracks: allSongs.tracks.map(({ id }) => ({ id })) },
        ...(Array.isArray(playlists) ? playlists : []),
      ]);
      return;
    }

    if (url.pathname.startsWith('/api/playlists/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/playlists/'.length));
      if (id === ALL_SONGS_ID) {
        sendJson(res, 200, buildAllSongsPlaylist());
        return;
      }
      const playlists = readJsonFile(PLAYLISTS_FILE, []);
      const playlist = playlists.find((p) => p.id === id);
      if (!playlist) {
        sendJson(res, 404, { error: 'Playlist tidak ditemukan.' });
        return;
      }
      sendJson(res, 200, playlist);
      return;
    }

    if (url.pathname.startsWith('/api/audio/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/audio/'.length)).replace(/\.\w+$/, '');
      await serveAudio(req, res, id);
      return;
    }

    if (url.pathname.startsWith('/api/track/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/track/'.length));
      if (!UUID_RE.test(id)) {
        sendJson(res, 400, { error: 'Invalid track id.' });
        return;
      }
      const clip = await getClip(id);
      sendJson(res, 200, normalizeTrack(clip));
      return;
    }

    if (url.pathname === '/api/playlist' || url.pathname.startsWith('/api/playlist/')) {
      const fromPath = url.pathname.startsWith('/api/playlist/')
        ? decodeURIComponent(url.pathname.slice('/api/playlist/'.length))
        : '';
      const input =
        url.searchParams.get('url') ||
        url.searchParams.get('id') ||
        fromPath ||
        '';

      const id = extractPlaylistId(input);
      if (!id) {
        sendJson(res, 400, {
          error:
            'That doesn’t look like a Suno playlist link. Paste something like https://suno.com/playlist/…',
        });
        return;
      }

      const playlist = await fetchPlaylist(id);
      sendJson(res, 200, playlist);
      return;
    }

    sendJson(res, 404, { error: 'Not found.' });
  } catch (err) {
    const status = err.status || 500;
    const message =
      status === 500 ? 'Something went wrong on the server. Check the terminal for details.' : err.message;
    if (status === 500) console.error(err);
    sendJson(res, status, { error: message });
  }
});

// Keep the in-memory caches from growing forever.
setInterval(() => {
  const now = Date.now();
  for (const store of [cache, clipCache, rightsCache]) {
    for (const [key, value] of store) {
      if (value.expires <= now) store.delete(key);
    }
  }
  for (const [token, grant] of downloadTokens) {
    if (grant.expires <= now) downloadTokens.delete(token);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Suno Player is running');
  console.log(`  → http://localhost:${PORT}`);
  console.log('');
  console.log(`  Private playlists: ${SUNO_TOKEN ? 'SUNO_TOKEN set' : 'no SUNO_TOKEN set (public playlists only)'}`);
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=3001 npm start`);
    process.exit(1);
  }
  throw err;
});
