const SHELL_CACHE = 'suno-player-offline-shell-v1';
const DATA_CACHE = 'suno-player-offline-data-v1';
const AUDIO_CACHE = 'suno-player-offline-audio-v1';
const META_CACHE = 'suno-player-offline-meta-v1';
const POLICY_URL = new URL('/__offline_cache_policy__', self.location.origin).href;
let offlinePolicy = { enabled: true, maxMB: 100, clearVersion: 0 };

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(['/', '/about', '/push-client.js']);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await loadOfflinePolicy();
    await self.clients.claim();
  })());
});

function audioCacheKey(url) {
  const key = new URL(url, self.location.origin);
  key.search = '';
  key.hash = '';
  return key.href;
}

function isPublicPage(pathname) {
  return pathname === '/' || pathname === '/about' || pathname === '/about/';
}

function isCacheableData(pathname) {
  return pathname === '/api/config'
    || pathname === '/api/playlists'
    || pathname.startsWith('/api/playlists/')
    || pathname === '/api/playlist'
    || pathname.startsWith('/api/playlist/')
    || pathname.startsWith('/api/track/');
}

async function loadOfflinePolicy() {
  const cache = await caches.open(META_CACHE);
  const saved = await cache.match(POLICY_URL);
  if (!saved) return;
  const value = await saved.json();
  offlinePolicy = {
    enabled: value.enabled !== false,
    maxMB: Number.isInteger(value.maxMB) ? Math.min(2048, Math.max(16, value.maxMB)) : 100,
    clearVersion: Number.isSafeInteger(value.clearVersion) ? Math.max(0, value.clearVersion) : 0,
  };
}

async function trimAudioCache(maxBytes) {
  const cache = await caches.open(AUDIO_CACHE);
  const entries = await Promise.all((await cache.keys()).map(async (request) => {
    const response = await cache.match(request);
    return {
      request,
      size: Number(response?.headers.get('content-length')) || 0,
      storedAt: Number(response?.headers.get('x-offline-cached-at')) || 0,
    };
  }));
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries.sort((a, b) => a.storedAt - b.storedAt)) {
    if (total <= maxBytes) break;
    await cache.delete(entry.request);
    total -= entry.size;
  }
}

async function applyOfflinePolicy(value) {
  const policy = {
    enabled: value.enabled !== false,
    maxMB: Number.isInteger(value.maxMB) ? Math.min(2048, Math.max(16, value.maxMB)) : 100,
    clearVersion: Number.isSafeInteger(value.clearVersion) ? Math.max(0, value.clearVersion) : 0,
  };
  const meta = await caches.open(META_CACHE);
  const previousResponse = await meta.match(POLICY_URL);
  const previous = previousResponse ? await previousResponse.json() : null;
  if ((!policy.enabled && previous?.enabled !== false) ||
      policy.clearVersion > (previous?.clearVersion || 0)) {
    await Promise.all([SHELL_CACHE, DATA_CACHE, AUDIO_CACHE].map((name) => caches.delete(name)));
  }
  offlinePolicy = policy;
  await meta.put(POLICY_URL, new Response(JSON.stringify(policy), {
    headers: { 'content-type': 'application/json' },
  }));
  if (policy.enabled) await trimAudioCache(policy.maxMB * 1024 * 1024);
}

async function offlineTrackEntries() {
  const cache = await caches.open(AUDIO_CACHE);
  return Promise.all((await cache.keys()).map(async (request) => {
    const response = await cache.match(request);
    return {
      url: new URL(request.url).pathname,
      size: Number(response?.headers.get('content-length')) || 0,
    };
  }));
}

async function cacheTrack(message) {
  if (!offlinePolicy.enabled) throw new Error('Cache lagu offline sedang dimatikan admin.');
  const url = new URL(message.url, self.location.origin);
  if (url.origin !== self.location.origin || !/^\/api\/audio\/[0-9a-f-]{36}$/i.test(url.pathname)) {
    throw new Error('Alamat audio tidak valid.');
  }

  const key = audioCacheKey(url);
  const cache = await caches.open(AUDIO_CACHE);
  if (await cache.match(key)) return { cached: true, alreadyCached: true };

  const offlineUrl = `${key}?offline=1`;
  const head = await fetch(offlineUrl, { method: 'HEAD', cache: 'no-store' });
  if (!head.ok) throw new Error(`Lagu tidak dapat disiapkan (${head.status}).`);
  const expectedSize = Number(head.headers.get('content-length'));
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new Error('Ukuran audio tidak diketahui, lagu belum bisa disimpan.');
  }
  const maxBytes = offlinePolicy.maxMB * 1024 * 1024;
  if (expectedSize > maxBytes) {
    throw new Error(`Ukuran lagu melebihi batas cache ${offlinePolicy.maxMB} MB.`);
  }

  const response = await fetch(offlineUrl, { cache: 'no-store' });
  if (!response.ok || response.status !== 200) {
    throw new Error(`Lagu gagal diunduh (${response.status}).`);
  }
  const responseSize = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(responseSize) || responseSize !== expectedSize) {
    throw new Error('Ukuran audio berubah saat diunduh. Coba simpan lagi.');
  }

  const entries = await offlineTrackEntries();
  let usedBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const oldestFirst = [...entries].sort((a, b) => a.size - b.size);
  const timestamps = await Promise.all((await cache.keys()).map(async (request) => {
    const cached = await cache.match(request);
    return { request, storedAt: Number(cached?.headers.get('x-offline-cached-at')) || 0 };
  }));
  oldestFirst.sort((a, b) => {
    const aTime = timestamps.find((entry) => new URL(entry.request.url).pathname === a.url)?.storedAt || 0;
    const bTime = timestamps.find((entry) => new URL(entry.request.url).pathname === b.url)?.storedAt || 0;
    return aTime - bTime;
  });
  for (const entry of oldestFirst) {
    if (usedBytes + responseSize <= maxBytes) break;
    const request = timestamps.find((item) => new URL(item.request.url).pathname === entry.url)?.request;
    if (request) await cache.delete(request);
    usedBytes -= entry.size;
  }

  const headers = new Headers(response.headers);
  headers.set('x-offline-cached-at', String(Date.now()));
  await cache.put(key, new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }));
  return { cached: true, size: responseSize };
}

function rangeResponse(request, response) {
  const range = request.headers.get('range');
  if (!range) return response;
  const size = Number(response.headers.get('content-length'));
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!Number.isSafeInteger(size) || size <= 0 || !match || (!match[1] && !match[2])) {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${Number.isSafeInteger(size) ? size : '*'}` },
    });
  }

  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    end = end === null ? size - 1 : Math.min(end, size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${size}` },
    });
  }

  return response.blob().then((blob) => {
    const chunk = blob.slice(start, end + 1, response.headers.get('content-type') || '');
    const headers = new Headers(response.headers);
    headers.set('content-length', String(chunk.size));
    headers.set('content-range', `bytes ${start}-${end}/${size}`);
    headers.set('accept-ranges', 'bytes');
    return new Response(chunk, { status: 206, headers });
  });
}

async function cachedAudio(request) {
  if (!offlinePolicy.enabled) return null;
  const cache = await caches.open(AUDIO_CACHE);
  const response = await cache.match(audioCacheKey(request.url));
  return response ? rangeResponse(request, response) : null;
}

async function networkFirst(request, cacheName, fallbackPath) {
  const cache = await caches.open(cacheName);
  const cacheKey = new Request(request.url, {
    headers: request.headers,
    credentials: 'same-origin',
  });
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const cached = await cache.match(cacheKey) || (fallbackPath ? await cache.match(fallbackPath) : null);
    if (cached) return cached;
    throw error;
  }
  if (response.ok) {
    try {
      await cache.put(cacheKey, response.clone());
    } catch (error) {
      console.error('Unable to cache this offline response:', error);
    }
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !offlinePolicy.enabled) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/nugaduhna') ||
      url.pathname.startsWith('/api/admin/')) return;

  if (url.pathname.startsWith('/api/audio/')) {
    event.respondWith((async () => {
      const cached = await cachedAudio(request);
      return cached || fetch(request);
    })());
    return;
  }
  if (isCacheableData(url.pathname)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }
  if (request.mode === 'navigate' && isPublicPage(url.pathname)) {
    const fallback = url.pathname.startsWith('/about') ? '/about' : '/';
    event.respondWith(networkFirst(request, SHELL_CACHE, fallback));
    return;
  }
  if (url.pathname === '/push-client.js') {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});

self.addEventListener('message', (event) => {
  const port = event.ports[0];
  const reply = (value) => { if (port) port.postMessage(value); };
  event.waitUntil((async () => {
    try {
      const message = event.data || {};
      if (message.type === 'APPLY_OFFLINE_POLICY') {
        await applyOfflinePolicy(message.policy || {});
        reply({ ok: true });
        return;
      }
      if (message.type === 'CACHE_TRACK') {
        reply({ ok: true, ...await cacheTrack(message) });
        return;
      }
      if (message.type === 'DELETE_TRACK') {
        const key = audioCacheKey(message.url);
        const cache = await caches.open(AUDIO_CACHE);
        reply({ ok: true, deleted: await cache.delete(key) });
        return;
      }
      if (message.type === 'GET_OFFLINE_STATUS') {
        const tracks = offlinePolicy.enabled ? await offlineTrackEntries() : [];
        reply({
          ok: true,
          enabled: offlinePolicy.enabled,
          maxMB: offlinePolicy.maxMB,
          tracks,
          usedBytes: tracks.reduce((sum, track) => sum + track.size, 0),
        });
        return;
      }
      reply({ ok: false, error: 'Perintah cache tidak dikenal.' });
    } catch (error) {
      reply({ ok: false, error: error.message || 'Cache offline gagal diperbarui.' });
    }
  })());
});

function sameOriginPath(target) {
  try {
    const url = new URL(target, self.location.origin);
    return url.origin === self.location.origin ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  if (!payload || typeof payload !== 'object') payload = {};

  const title = typeof payload.title === 'string' ? payload.title : 'Lagu baru';
  const body = typeof payload.body === 'string' ? payload.body : 'Ada lagu baru di Suno Playlist Player.';
  const path = sameOriginPath(typeof payload.url === 'string' ? payload.url : '/');
  const tag = typeof payload.tag === 'string' ? payload.tag : 'budijoi-song-added';
  const notificationId = typeof payload.notificationId === 'string' ? payload.notificationId : tag;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const playerIsVisible = windows.some((client) => {
      try {
        const clientUrl = new URL(client.url);
        return client.visibilityState === 'visible'
          && (clientUrl.pathname === '/' || clientUrl.pathname === '/about' || clientUrl.pathname === '/about/');
      } catch {
        return false;
      }
    });
    if (playerIsVisible) return;

    await self.registration.showNotification(title, {
      body,
      tag,
      actions: [{ action: 'play-now', title: 'Mainkan sekarang' }],
      data: { url: path, notificationId },
      renotify: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (typeof self.registration.getNotifications === 'function') {
      const notifications = await self.registration.getNotifications({ tag });
      notifications.forEach((notification) => {
        if (notification.data?.notificationId === notificationId) notification.close();
      });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = typeof event.notification.data?.url === 'string' ? event.notification.data.url : '/';
  const path = sameOriginPath(target);

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const player = windows.find((client) => {
      try {
        return new URL(client.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });
    if (player) {
      if (typeof player.navigate === 'function') await player.navigate(path);
      await player.focus();
      return;
    }
    await self.clients.openWindow(path);
  })());
});
