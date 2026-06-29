'use strict';
/*
 * Live TV module.
 *
 * Loads the free Free-TV/IPTV M3U playlist (1,800+ public channels), parses it
 * into channel objects, flags sports channels, and exposes:
 *   - getChannels()  -> parsed channel list (cached, refreshed every 6h)
 *   - proxyHandler   -> Express handler that proxies HLS manifests/segments and
 *                       adds CORS so streams play directly in the browser.
 *
 * The proxy rewrites manifest URIs to route segments/keys/child playlists back
 * through itself, and guards against SSRF (blocks private/reserved IPs) and open
 * relaying (only hosts seen in the playlist or referenced by an allowed manifest
 * are permitted).
 *
 * Env:
 *   IPTV_PLAYLIST_URL   override the source playlist URL
 *   TV_DISABLE=1        disable the feature entirely
 */

const dns = require('dns').promises;
const net = require('net');
const { Readable } = require('stream');

const PLAYLIST_URL = process.env.IPTV_PLAYLIST_URL ||
  'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8';
const REFRESH_MS = 6 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let channels = [];
let staticHosts = new Set();          // hosts that appear in the playlist
const dynamicHosts = new Set();        // segment/CDN hosts learned from manifests
let lastLoaded = 0;
let loadingPromise = null;

// Sports detection by channel name / group / tvg-id keywords.
const SPORT_RE = new RegExp([
  '\\bsports?\\b', 'espn', 'bein', 'dazn', 'eurosport', 'sky\\s?sport', 'supersport',
  'sport\\s?tv', 'fox\\s?sport', 'nba\\s?tv', '\\bnfl\\b', '\\bmlb\\b', '\\bnhl\\b',
  'tennis', '\\bgolf\\b', 'motogp', 'formula\\s?1', '\\bf1\\b', '\\bufc\\b', 'boxing',
  '\\bwwe\\b', 'cricket', 'rugby', 'setanta', '\\btsn\\b', 'sportsnet', 'willow',
  'elevensports', 'eleven\\s?sport', 'polsat\\s?sport', 'nova\\s?sport', 'arena\\s?sport',
  'sport\\s?klub', 'sportklub', 'astro\\s?sport', '\\bssc\\b', 'match\\s?tv', '\\bgol\\b',
  'la\\s?liga', 'laliga', 'bundesliga', 'serie\\s?a', 'ligue\\s?1', 'premier\\s?league',
  'champions', 'football', 'soccer', 'fightbox', 'fast\\s?sport', 'true\\s?sport',
].join('|'), 'i');

function cleanName(s) {
  // Strip the playlist's circled-letter status badges (Ⓢ Ⓖ Ⓨ Ⓣ etc.) and tidy.
  return String(s || '')
    .replace(/[\u2460-\u24FF\u3251-\u32BF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyKind(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/twitch\.tv/i.test(url)) return 'twitch';
  if (/dailymotion\.com/i.test(url)) return 'dailymotion';
  if (/\.m3u8(\?|$)/i.test(url) || url.includes('.m3u8')) return 'hls';
  return 'other';
}

function parsePlaylist(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const hosts = new Set();
  let cur = null;
  let idx = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const re = /([a-zA-Z0-9-]+)="([^"]*)"/g;
      let m;
      while ((m = re.exec(line))) attrs[m[1]] = m[2];
      const name = line.indexOf(',') >= 0 ? line.slice(line.indexOf(',') + 1).trim() : '';
      cur = {
        name: cleanName(name) || cleanName(attrs['tvg-name']) || 'Channel',
        logo: attrs['tvg-logo'] || '',
        country: (attrs['tvg-country'] || '').toUpperCase(),
        group: attrs['group-title'] || 'Other',
        tvgId: attrs['tvg-id'] || '',
      };
    } else if (!line.startsWith('#')) {
      if (cur) {
        cur.url = line;
        cur.kind = classifyKind(line);
        cur.id = 'tv_' + (idx++);
        cur.sport = SPORT_RE.test(cur.name) || SPORT_RE.test(cur.group) || SPORT_RE.test(cur.tvgId);
        delete cur.tvgId;
        try { hosts.add(new URL(line).hostname.toLowerCase()); } catch (e) { /* skip */ }
        out.push(cur);
        cur = null;
      }
    }
  }
  return { list: out, hosts };
}

async function loadPlaylist() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(PLAYLIST_URL, { signal: ctrl.signal, headers: { 'user-agent': UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    const { list, hosts } = parsePlaylist(text);
    if (list.length) {
      channels = list;
      staticHosts = hosts;
      lastLoaded = Date.now();
      console.log('[tv] loaded', list.length, 'channels (' + list.filter((c) => c.sport).length + ' sports) from', hosts.size, 'hosts');
    }
  } catch (e) {
    console.warn('[tv] playlist load failed:', e.message);
  } finally {
    clearTimeout(t);
  }
}

// ── Health checking ─────────────────────────────────────────────────────────
// We probe every HLS stream from the server. Because all playback is proxied
// (server -> stream), a server-side probe is an exact predictor of whether a
// channel will play for users. Dead and geo-blocked-for-us channels get hidden.
const HEALTH_MS = Number(process.env.TV_HEALTH_MS) || 30 * 60 * 1000;
const HEALTH_CONC = Number(process.env.TV_HEALTH_CONC) || 30;
const health = new Map(); // url -> { ok, fails, t }
let healthRunning = false;
let healthDone = false;

async function probeStream(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: '*/*', referer: u.origin + '/' },
    });
    if (!r.ok) return false;
    const ct = r.headers.get('content-type') || '';
    const txt = await r.text();
    return /#EXTM3U/.test(txt) || /mpegurl|vnd\.apple/i.test(ct);
  } catch (e) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function runHealthCheck() {
  if (healthRunning || !channels.length) return;
  healthRunning = true;
  const started = Date.now();
  try {
    const targets = channels.filter((c) => c.kind === 'hls');
    let i = 0;
    async function worker() {
      while (i < targets.length) {
        const c = targets[i++];
        const ok = await probeStream(c.url);
        const cur = health.get(c.url) || { fails: 0 };
        health.set(c.url, ok ? { ok: true, fails: 0, t: Date.now() } : { ok: false, fails: (cur.fails || 0) + 1, t: Date.now() });
      }
    }
    const workers = [];
    for (let w = 0; w < HEALTH_CONC; w++) workers.push(worker());
    await Promise.all(workers);
    healthDone = true;
    const okN = targets.filter((c) => { const h = health.get(c.url); return h && h.ok; }).length;
    console.log('[tv] health check done:', okN, '/', targets.length, 'HLS channels online (' + Math.round((Date.now() - started) / 1000) + 's)');
  } finally {
    healthRunning = false;
  }
}

// A channel is shown unless we've confirmed it dead/blocked at least twice in a
// row (avoids flapping). Non-HLS channels open externally, so always shown.
function isLive(c) {
  if (c.kind !== 'hls') return true;
  const h = health.get(c.url);
  if (!h) return true;
  if (h.ok) return true;
  return h.fails < 2;
}

async function getChannels(opts) {
  opts = opts || {};
  if (!channels.length || Date.now() - lastLoaded > REFRESH_MS) {
    if (!loadingPromise) loadingPromise = loadPlaylist().finally(() => { loadingPromise = null; });
    if (!channels.length) await loadingPromise; // first call must wait
  }
  if (opts.liveOnly && healthDone) return channels.filter(isLive);
  return channels;
}

function init() {
  loadPlaylist().then(() => runHealthCheck());
  setInterval(() => { loadPlaylist().then(() => runHealthCheck()); }, REFRESH_MS).unref();
  setInterval(runHealthCheck, HEALTH_MS).unref();
}

// ── SSRF / open-relay protection ────────────────────────────────────────────
function ipIsPrivate(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;          // link-local
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] >= 224) return true;                            // multicast/reserved
    return false;
  }
  if (v === 6) {
    const lc = ip.toLowerCase();
    if (lc === '::1' || lc === '::') return true;
    if (lc.startsWith('fe80') || lc.startsWith('fc') || lc.startsWith('fd')) return true;
    const mapped = lc.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipIsPrivate(mapped[1]);
    return false;
  }
  return false;
}

const _dnsCache = new Map(); // host -> { t, safe }
async function ssrfSafe(host) {
  const h = host.toLowerCase();
  const c = _dnsCache.get(h);
  if (c && Date.now() - c.t < 5 * 60 * 1000) return c.safe;
  let safe = true;
  try {
    if (net.isIP(h)) {
      safe = !ipIsPrivate(h);
    } else {
      const addrs = await dns.lookup(h, { all: true });
      safe = addrs.length > 0 && addrs.every((a) => !ipIsPrivate(a.address));
    }
  } catch (e) {
    safe = false;
  }
  _dnsCache.set(h, { t: Date.now(), safe });
  return safe;
}

function hostAllowed(host) {
  const h = String(host || '').toLowerCase();
  return staticHosts.has(h) || dynamicHosts.has(h);
}

function absolutize(u, base) {
  try { return new URL(u, base).href; } catch (e) { return null; }
}
function proxify(abs) {
  return '/api/tv/proxy?url=' + encodeURIComponent(abs);
}
function seedHost(abs) {
  try { dynamicHosts.add(new URL(abs).hostname.toLowerCase()); } catch (e) { /* skip */ }
}

function rewriteManifest(body, baseUrl) {
  const lines = body.split(/\r?\n/);
  const out = lines.map((line) => {
    if (!line) return line;
    if (line.startsWith('#')) {
      // Rewrite URI="..." attributes (EXT-X-KEY, EXT-X-MEDIA, EXT-X-MAP, etc.)
      return line.replace(/URI="([^"]+)"/g, (mm, uri) => {
        const abs = absolutize(uri, baseUrl);
        if (!abs) return mm;
        seedHost(abs);
        return 'URI="' + proxify(abs) + '"';
      });
    }
    const abs = absolutize(line.trim(), baseUrl);
    if (!abs) return line;
    seedHost(abs);
    return proxify(abs);
  });
  return out.join('\n');
}

async function proxyHandler(req, res) {
  if (process.env.TV_DISABLE === '1') return res.status(404).send('disabled');
  const target = req.query.url;
  if (!target || typeof target !== 'string') return res.status(400).send('missing url');
  let u;
  try { u = new URL(target); } catch (e) { return res.status(400).send('bad url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return res.status(400).send('bad protocol');

  // Make sure the playlist (and thus the host allowlist) is loaded.
  if (!channels.length) { try { await getChannels(); } catch (e) { /* ignore */ } }
  if (!hostAllowed(u.hostname)) return res.status(403).send('host not allowed');
  if (!(await ssrfSafe(u.hostname))) return res.status(403).send('blocked');

  const headers = { 'user-agent': UA, accept: '*/*', referer: u.origin + '/', origin: u.origin };
  if (req.headers.range) headers.range = req.headers.range;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let r;
  try {
    r = await fetch(target, { headers, redirect: 'follow', signal: ctrl.signal });
  } catch (e) {
    clearTimeout(t);
    return res.status(502).send('upstream error');
  }

  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'range');
  res.set('Access-Control-Expose-Headers', 'content-length,content-range');

  const ct = r.headers.get('content-type') || '';
  const isManifest = /mpegurl|vnd\.apple/i.test(ct) || /\.m3u8(\?|$)/i.test(u.pathname) || /\.m3u8/i.test(target);

  if (isManifest) {
    let body;
    try { body = await r.text(); } catch (e) { clearTimeout(t); return res.status(502).send('read error'); }
    clearTimeout(t);
    res.status(r.status);
    res.set('content-type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-cache');
    return res.send(rewriteManifest(body, target));
  }

  // Binary passthrough (segments, encryption keys, init files).
  res.status(r.status);
  res.set('content-type', ct || 'application/octet-stream');
  const cl = r.headers.get('content-length'); if (cl) res.set('content-length', cl);
  const cr = r.headers.get('content-range'); if (cr) res.set('content-range', cr);
  const ar = r.headers.get('accept-ranges'); if (ar) res.set('accept-ranges', ar);
  res.set('Cache-Control', 'no-cache');
  if (!r.body) { clearTimeout(t); return res.end(); }
  try {
    const nodeStream = Readable.fromWeb(r.body);
    nodeStream.on('end', () => clearTimeout(t));
    nodeStream.on('error', () => { clearTimeout(t); try { res.end(); } catch (e) {} });
    res.on('close', () => { try { nodeStream.destroy(); } catch (e) {} });
    nodeStream.pipe(res);
  } catch (e) {
    clearTimeout(t);
    try { res.end(); } catch (e2) {}
  }
}

module.exports = { init, getChannels, proxyHandler, _parsePlaylist: parsePlaylist, _probeStream: probeStream };
