'use strict';
/*
 * Automated market maker ("smart agent").
 *
 * Pulls FREE public data feeds, opens prediction markets from whatever is
 * happening, and auto-resolves them from the same feeds once the outcome is
 * known. Everything is deterministic (price thresholds, final scores) so there
 * is no guessing — no API keys, no LLM, no cost.
 *
 * Markets are peer-to-peer even-money, so auto-created markets carry NO house
 * bankroll risk; the house only ever collects the 10% rake on matched bets.
 *
 * Wired up in index.js:
 *   marketAgent.start({ createMarket, resolveMarket, listMarkets });
 *
 * Env switches:
 *   MARKET_AGENT=0                 disable the whole agent
 *   MARKET_AGENT_CRYPTO=0          disable the crypto provider
 *   MARKET_AGENT_SPORTS=0          disable the sports provider
 *   MARKET_AGENT_CREATE_MS         how often to open new markets (default 30m)
 *   MARKET_AGENT_RESOLVE_MS        how often to check for resolutions (default 2m)
 *   MARKET_AGENT_CRYPTO_HORIZON_MS crypto market lifetime (default 3h)
 *   MARKET_AGENT_SPORTS_MAX        max concurrent open sports markets (default 6)
 */

const CREATE_INTERVAL_MS = Number(process.env.MARKET_AGENT_CREATE_MS) || 30 * 60 * 1000;
const RESOLVE_INTERVAL_MS = Number(process.env.MARKET_AGENT_RESOLVE_MS) || 2 * 60 * 1000;
const FIRST_CREATE_DELAY_MS = 15 * 1000;

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'ZootGames-MarketAgent/1.0' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function fmtUTC(ts) {
  // e.g. "Tue, 24 Jun 14:00 UTC"
  const d = new Date(ts);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return days[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + mons[d.getUTCMonth()] + ' ' + hh + ':' + mm + ' UTC';
}

function roundPrice(n) {
  if (n >= 1000) return Math.round(n);
  if (n >= 1) return Math.round(n * 100) / 100;
  return Math.round(n * 10000) / 10000;
}

// ── Crypto provider (CoinGecko, free, no key) ───────────────────────────────
const CRYPTO_COINS = [
  { id: 'bitcoin', sym: 'BTC' },
  { id: 'ethereum', sym: 'ETH' },
  { id: 'solana', sym: 'SOL' },
];
const CRYPTO_HORIZON_MS = Number(process.env.MARKET_AGENT_CRYPTO_HORIZON_MS) || 3 * 60 * 60 * 1000;

const cryptoProvider = {
  id: 'crypto',
  enabled: process.env.MARKET_AGENT_CRYPTO !== '0',
  async generate(openAuto) {
    const have = new Set(openAuto.filter((m) => m.auto.provider === 'crypto').map((m) => m.auto.coinId));
    const need = CRYPTO_COINS.filter((c) => !have.has(c.id));
    if (!need.length) return [];
    const ids = need.map((c) => c.id).join(',');
    const data = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=usd');
    const out = [];
    const resolveAt = Date.now() + CRYPTO_HORIZON_MS;
    for (const c of need) {
      const price = data[c.id] && data[c.id].usd;
      if (!price) continue;
      const target = roundPrice(price);
      const tStr = '$' + target.toLocaleString('en-US');
      out.push({
        question: 'Will ' + c.sym + ' be above ' + tStr + ' at ' + fmtUTC(resolveAt) + '?',
        description: c.sym + ' is $' + price.toLocaleString('en-US') + ' right now. Resolves YES if the CoinGecko ' +
          c.sym + '/USD price is strictly above ' + tStr + ' at the listed time, otherwise NO.',
        category: 'Crypto',
        auto: { provider: 'crypto', coinId: c.id, sym: c.sym, target, resolveAt },
      });
    }
    return out;
  },
  async resolve(market) {
    const a = market.auto;
    if (Date.now() < a.resolveAt) return null;
    const data = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=' + a.coinId + '&vs_currencies=usd');
    const price = data[a.coinId] && data[a.coinId].usd;
    if (!price) return null;
    return price > a.target ? 'YES' : 'NO';
  },
};

// ── Sports provider (ESPN scoreboard, free, no key) ─────────────────────────
const SPORTS_LEAGUES = [
  { sport: 'basketball', league: 'nba', label: 'NBA' },
  { sport: 'baseball', league: 'mlb', label: 'MLB' },
  { sport: 'soccer', league: 'eng.1', label: 'Premier League' },
  { sport: 'hockey', league: 'nhl', label: 'NHL' },
];
const SPORTS_MAX_OPEN = Number(process.env.MARKET_AGENT_SPORTS_MAX) || 6;

function ymd(d) {
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
}

function espnUrl(s, datesParam) {
  let u = 'https://site.api.espn.com/apis/site/v2/sports/' + s.sport + '/' + s.league + '/scoreboard';
  if (datesParam) u += '?dates=' + datesParam;
  return u;
}

const _sbCache = new Map(); // url -> { t, data }
async function fetchScoreboard(s, datesParam) {
  const url = espnUrl(s, datesParam);
  const c = _sbCache.get(url);
  if (c && Date.now() - c.t < 60000) return c.data;
  const data = await fetchJson(url);
  _sbCache.set(url, { t: Date.now(), data });
  return data;
}

function parseCompetitors(ev) {
  const comp = ev.competitions && ev.competitions[0];
  if (!comp) return null;
  const cs = comp.competitors || [];
  const home = cs.find((c) => c.homeAway === 'home');
  const away = cs.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;
  return { home, away };
}

const sportsProvider = {
  id: 'sports',
  enabled: process.env.MARKET_AGENT_SPORTS !== '0',
  async generate(openAuto) {
    const openSports = openAuto.filter((m) => m.auto.provider === 'sports');
    if (openSports.length >= SPORTS_MAX_OPEN) return [];
    const have = new Set(openSports.map((m) => m.auto.eventId));
    const out = [];
    const now = Date.now();
    const windowMs = 48 * 60 * 60 * 1000;
    const datesParam = ymd(new Date(now)) + '-' + ymd(new Date(now + windowMs));
    for (const lg of SPORTS_LEAGUES) {
      if (openSports.length + out.length >= SPORTS_MAX_OPEN) break;
      let data;
      try { data = await fetchScoreboard(lg, datesParam); } catch (e) { continue; }
      const events = (data && data.events) || [];
      for (const ev of events) {
        if (openSports.length + out.length >= SPORTS_MAX_OPEN) break;
        const state = ev.status && ev.status.type && ev.status.type.state;
        if (state !== 'pre') continue;
        if (have.has(ev.id)) continue;
        const start = ev.date ? new Date(ev.date).getTime() : 0;
        if (!start || start < now || start > now + windowMs) continue;
        const p = parseCompetitors(ev);
        if (!p) continue;
        const homeName = p.home.team && (p.home.team.displayName || p.home.team.name);
        const awayName = p.away.team && (p.away.team.displayName || p.away.team.name);
        if (!homeName || !awayName) continue;
        out.push({
          question: 'Will ' + homeName + ' beat ' + awayName + '? (' + lg.label + ')',
          description: homeName + ' (home) vs ' + awayName + '. Starts ' + fmtUTC(start) +
            '. Resolves YES if ' + homeName + ' win; a draw or a loss resolves NO.',
          category: 'Sports',
          closesAt: start,
          auto: { provider: 'sports', sport: lg.sport, league: lg.league, eventId: ev.id, homeName, awayName, startAt: start },
        });
      }
    }
    return out;
  },
  async resolve(market) {
    const a = market.auto;
    if (Date.now() < a.startAt) return null;
    let data;
    const datesParam = ymd(new Date(a.startAt)) + '-' + ymd(new Date(a.startAt + 24 * 60 * 60 * 1000));
    try { data = await fetchScoreboard({ sport: a.sport, league: a.league }, datesParam); } catch (e) { return null; }
    const ev = ((data && data.events) || []).find((e) => e.id === a.eventId);
    if (!ev) return null; // aged off the board — leave for admin
    const st = ev.status && ev.status.type;
    if (!st || !st.completed) return null;
    const p = parseCompetitors(ev);
    if (!p) return null;
    const hs = parseInt(p.home.score, 10);
    const as = parseInt(p.away.score, 10);
    if (isNaN(hs) || isNaN(as)) return null;
    return hs > as ? 'YES' : 'NO';
  },
};

const PROVIDERS = [cryptoProvider, sportsProvider].filter((p) => p.enabled);

function start(deps) {
  const { createMarket, resolveMarket, listMarkets } = deps;
  if (process.env.MARKET_AGENT === '0') { console.log('[agent] disabled (MARKET_AGENT=0)'); return; }
  if (!PROVIDERS.length) { console.log('[agent] no providers enabled'); return; }
  console.log('[agent] starting — providers:', PROVIDERS.map((p) => p.id).join(', '),
    '| create every', Math.round(CREATE_INTERVAL_MS / 60000) + 'm, resolve every', Math.round(RESOLVE_INTERVAL_MS / 60000) + 'm');

  async function tickCreate() {
    try {
      const openAuto = listMarkets().filter((m) => m.auto && m.status !== 'resolved');
      for (const prov of PROVIDERS) {
        try {
          const candidates = await prov.generate(openAuto);
          for (const c of candidates) openAuto.push(createMarket(c));
          if (candidates.length) console.log('[agent]', prov.id, 'opened', candidates.length, 'market(s)');
        } catch (e) { console.error('[agent] generate error (' + prov.id + '):', e.message); }
      }
    } catch (e) { console.error('[agent] tickCreate error:', e.message); }
  }

  async function tickResolve() {
    try {
      const pending = listMarkets().filter((m) => m.auto && m.status !== 'resolved');
      for (const m of pending) {
        const prov = PROVIDERS.find((p) => p.id === m.auto.provider);
        if (!prov) continue;
        try {
          const outcome = await prov.resolve(m);
          if (outcome) {
            console.log('[agent] resolving', m.id, '->', outcome, '(' + m.question + ')');
            await resolveMarket(m.id, outcome);
          }
        } catch (e) { console.error('[agent] resolve error (' + m.id + '):', e.message); }
      }
    } catch (e) { console.error('[agent] tickResolve error:', e.message); }
  }

  setTimeout(tickCreate, FIRST_CREATE_DELAY_MS);
  setInterval(tickCreate, CREATE_INTERVAL_MS);
  setInterval(tickResolve, RESOLVE_INTERVAL_MS);
}

module.exports = { start, fetchJson, _providers: { cryptoProvider, sportsProvider } };
