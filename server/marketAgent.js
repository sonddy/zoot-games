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
 *   MARKET_AGENT_GOALS=0          disable soccer player-goal markets
 *   MARKET_AGENT_POLY=0           disable the Polymarket mirror provider
 *   MARKET_AGENT_POLY_MAX         max concurrent mirrored markets (default 8)
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

// ── Crypto provider (multi-source, free, no key) ────────────────────────────
// CoinGecko's free API frequently rate-limits datacenter IPs (Render), so we
// fetch from Coinbase first (US-datacenter friendly), then Kraken, then
// CoinGecko as a last resort.
const CRYPTO_COINS = [
  { sym: 'BTC' },
  { sym: 'ETH' },
  { sym: 'SOL' },
];
const CRYPTO_HORIZON_MS = Number(process.env.MARKET_AGENT_CRYPTO_HORIZON_MS) || 3 * 60 * 60 * 1000;

async function getCryptoUsd(sym) {
  // 1) Coinbase spot
  try {
    const d = await fetchJson('https://api.coinbase.com/v2/prices/' + sym + '-USD/spot');
    const p = d && d.data && parseFloat(d.data.amount);
    if (p) return p;
  } catch (e) { /* fall through */ }
  // 2) Kraken
  try {
    const pairMap = { BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD' };
    const d = await fetchJson('https://api.kraken.com/0/public/Ticker?pair=' + pairMap[sym]);
    const res = d && d.result;
    if (res) {
      const k = Object.keys(res)[0];
      const p = res[k] && res[k].c && parseFloat(res[k].c[0]);
      if (p) return p;
    }
  } catch (e) { /* fall through */ }
  // 3) CoinGecko
  try {
    const idMap = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana' };
    const id = idMap[sym];
    const d = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=' + id + '&vs_currencies=usd');
    const p = d[id] && d[id].usd;
    if (p) return p;
  } catch (e) { /* fall through */ }
  return null;
}

const cryptoProvider = {
  id: 'crypto',
  enabled: process.env.MARKET_AGENT_CRYPTO !== '0',
  async generate(openAuto) {
    const have = new Set(openAuto.filter((m) => m.auto.provider === 'crypto').map((m) => m.auto.sym));
    const need = CRYPTO_COINS.filter((c) => !have.has(c.sym));
    if (!need.length) return [];
    const out = [];
    const resolveAt = Date.now() + CRYPTO_HORIZON_MS;
    for (const c of need) {
      const price = await getCryptoUsd(c.sym);
      if (!price) continue;
      const target = roundPrice(price);
      const tStr = '$' + target.toLocaleString('en-US');
      out.push({
        question: 'Will ' + c.sym + ' be above ' + tStr + ' at ' + fmtUTC(resolveAt) + '?',
        description: c.sym + ' is $' + price.toLocaleString('en-US') + ' right now. Resolves YES if the ' +
          c.sym + '/USD price is strictly above ' + tStr + ' at the listed time, otherwise NO.',
        category: 'Crypto',
        auto: { provider: 'crypto', sym: c.sym, target, resolveAt },
      });
    }
    return out;
  },
  async resolve(market) {
    const a = market.auto;
    if (Date.now() < a.resolveAt) return null;
    const price = await getCryptoUsd(a.sym);
    if (!price) return null;
    return price > a.target ? 'YES' : 'NO';
  },
};

// ── Weather provider (Open-Meteo, free, no key) ─────────────────────────────
const WEATHER_CITIES = [
  { name: 'New York', lat: 40.71, lon: -74.01 },
  { name: 'London', lat: 51.51, lon: -0.13 },
  { name: 'Tokyo', lat: 35.68, lon: 139.69 },
  { name: 'Paris', lat: 48.85, lon: 2.35 },
  { name: 'Dubai', lat: 25.2, lon: 55.27 },
  { name: 'Sydney', lat: -33.87, lon: 151.21 },
];
const WEATHER_MAX_OPEN = Number(process.env.MARKET_AGENT_WEATHER_MAX) || 3;

const weatherProvider = {
  id: 'weather',
  enabled: process.env.MARKET_AGENT_WEATHER !== '0',
  async generate(openAuto) {
    const openW = openAuto.filter((m) => m.auto.provider === 'weather');
    if (openW.length >= WEATHER_MAX_OPEN) return [];
    const haveCities = new Set(openW.map((m) => m.auto.name));
    const out = [];
    for (const city of WEATHER_CITIES) {
      if (openW.length + out.length >= WEATHER_MAX_OPEN) break;
      if (haveCities.has(city.name)) continue;
      let data;
      try {
        data = await fetchJson('https://api.open-meteo.com/v1/forecast?latitude=' + city.lat + '&longitude=' + city.lon +
          '&daily=temperature_2m_max&timezone=UTC&forecast_days=2');
      } catch (e) { continue; }
      const days = data && data.daily;
      if (!days || !days.time || days.time.length < 2) continue;
      const date = days.time[1];
      const forecastMax = days.temperature_2m_max[1];
      if (forecastMax == null) continue;
      const threshold = Math.round(forecastMax);
      const dayStart = new Date(date + 'T00:00:00Z').getTime();
      const resolveAt = dayStart + 28 * 60 * 60 * 1000; // ~04:00 UTC the following day
      out.push({
        question: 'Will ' + city.name + "'s high beat " + threshold + '\u00B0C on ' + date + '?',
        description: 'Forecast high for ' + city.name + ' on ' + date + ' (UTC) is ~' + Math.round(forecastMax) +
          '\u00B0C. Resolves YES if the actual daily high is strictly above ' + threshold + '\u00B0C.',
        category: 'Weather',
        closesAt: dayStart,
        auto: { provider: 'weather', name: city.name, lat: city.lat, lon: city.lon, date, threshold, resolveAt },
      });
    }
    return out;
  },
  async resolve(market) {
    const a = market.auto;
    if (Date.now() < a.resolveAt) return null;
    let data;
    try {
      data = await fetchJson('https://api.open-meteo.com/v1/forecast?latitude=' + a.lat + '&longitude=' + a.lon +
        '&daily=temperature_2m_max&timezone=UTC&past_days=3&forecast_days=1');
    } catch (e) { return null; }
    const days = data && data.daily;
    if (!days || !days.time) return null;
    const idx = days.time.indexOf(a.date);
    if (idx < 0) return null;
    const actual = days.temperature_2m_max[idx];
    if (actual == null) return null;
    return actual > a.threshold ? 'YES' : 'NO';
  },
};

// ── Markets provider — Crypto Fear & Greed (alternative.me, free) ────────────
const fngProvider = {
  id: 'fng',
  enabled: process.env.MARKET_AGENT_FNG !== '0',
  async generate(openAuto) {
    const open = openAuto.filter((m) => m.auto.provider === 'fng');
    if (open.length >= 1) return [];
    let data;
    try { data = await fetchJson('https://api.alternative.me/fng/?limit=1'); } catch (e) { return []; }
    const cur = data && data.data && data.data[0];
    const val = cur && parseInt(cur.value, 10);
    if (!val && val !== 0) return [];
    // resolve just after the index refreshes (daily ~00:00 UTC)
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 1, 0, 0));
    return [{
      question: 'Will the Crypto Fear & Greed Index show Greed (\u2265 55) tomorrow?',
      description: 'The index is ' + val + ' (' + (cur.value_classification || '') + ') right now. Resolves YES if the ' +
        'next daily reading is 55 or higher, otherwise NO.',
      category: 'Markets',
      auto: { provider: 'fng', threshold: 55, resolveAt: next.getTime() },
    }];
  },
  async resolve(market) {
    const a = market.auto;
    if (Date.now() < a.resolveAt) return null;
    let data;
    try { data = await fetchJson('https://api.alternative.me/fng/?limit=1'); } catch (e) { return null; }
    const cur = data && data.data && data.data[0];
    const val = cur && parseInt(cur.value, 10);
    if (!val && val !== 0) return null;
    return val >= a.threshold ? 'YES' : 'NO';
  },
};

// ── Polymarket mirror provider (Gamma API, free, read-only) ─────────────────
// Mirrors trending real-money Polymarket questions onto our P2P board and
// settles them to match Polymarket's own resolved outcome. No trading, no auth.
const POLY_ENABLED = process.env.MARKET_AGENT_POLY !== '0';
const POLY_MAX_OPEN = Number(process.env.MARKET_AGENT_POLY_MAX) || 8;
const POLY_MIN_VOL24 = Number(process.env.MARKET_AGENT_POLY_MIN_VOL) || 25000;
const POLY_MAX_DAYS = Number(process.env.MARKET_AGENT_POLY_MAX_DAYS) || 45;
const POLY_MIN_HOURS = Number(process.env.MARKET_AGENT_POLY_MIN_HOURS) || 6;
const POLY_GAMMA = 'https://gamma-api.polymarket.com';

function classifyPoly(q) {
  const s = String(q || '').toLowerCase();
  const has = (arr) => arr.some((w) => s.includes(w));
  if (has(['bitcoin', 'btc', 'ethereum', ' eth ', 'solana', 'crypto', 'dogecoin', 'xrp', 'coinbase', 'binance', 'stablecoin', 'memecoin'])) return 'Crypto';
  if (has(['election', 'president', 'senate', 'congress', 'governor', 'prime minister', 'parliament', 'ballot', 'nominee', 'primary', 'impeach', 'shutdown', 'supreme court', 'cabinet', 'referendum'])) return 'Politics';
  if (has(['fed ', 'interest rate', 'rate cut', 'gdp', 'inflation', 'recession', 's&p', 'nasdaq', ' ipo', 'earnings', 'tariff', 'jobs report', 'unemployment'])) return 'Business';
  if (has(['box office', 'oscar', 'grammy', 'album', 'spotify', 'billboard', 'netflix', 'emmy', 'movie', 'rotten tomatoes', 'celebrity'])) return 'Entertainment';
  return 'News';
}

// Sports questions are already covered deterministically by our ESPN providers,
// so we skip Polymarket's sports duplicates (match winners, "Will X win on <date>?").
function polyLooksLikeSports(q) {
  const s = String(q || '').toLowerCase();
  if (/\bwin on \d{4}-\d{2}-\d{2}/.test(s)) return true;
  if (/\bvs\.?\b/.test(s)) return true;
  return ['world cup', 'super bowl', ' nba', ' nfl', ' mlb', ' nhl', 'premier league', 'la liga',
    'serie a', 'champions league', 'ufc', 'fifa', 'playoff', 'grand prix', 'formula 1', ' f1 ',
    'tennis', 'golf', 'olympic', 'win the match', 'win the game'].some((w) => s.includes(w));
}

function parseJsonArr(v) {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

const polymarketProvider = {
  id: 'polymarket',
  enabled: POLY_ENABLED,
  async generate(openAuto) {
    const open = openAuto.filter((m) => m.auto.provider === 'polymarket');
    if (open.length >= POLY_MAX_OPEN) return [];
    const have = new Set(open.map((m) => m.auto.conditionId || m.auto.id));
    // Pull both "trending now" (24h volume) and big standing markets (all-time volume).
    const rows = [];
    for (const order of ['volume24hr', 'volumeNum']) {
      try {
        const d = await fetchJson(POLY_GAMMA + '/markets?closed=false&active=true&archived=false&order=' + order + '&ascending=false&limit=60');
        if (Array.isArray(d)) rows.push(...d);
      } catch (e) { /* ignore one source failing */ }
    }
    const now = Date.now();
    const out = [];
    const seen = new Set();
    for (const m of rows) {
      if (open.length + out.length >= POLY_MAX_OPEN) break;
      if (!m || m.closed || m.active === false || m.archived) continue;
      const key = m.conditionId || String(m.id);
      if (!key || have.has(key) || seen.has(key)) continue;
      seen.add(key);
      const outcomes = parseJsonArr(m.outcomes).map((o) => String(o).toLowerCase());
      if (outcomes.length !== 2 || outcomes[0] !== 'yes' || outcomes[1] !== 'no') continue;
      const prices = parseJsonArr(m.outcomePrices).map(Number);
      const yes = prices[0];
      if (!isFinite(yes) || yes > 0.95 || yes < 0.05) continue; // skip near-decided
      const vol24 = Number(m.volume24hr) || 0;
      if (vol24 < POLY_MIN_VOL24) continue;
      const end = Date.parse(m.endDateIso || m.endDate || '');
      if (!end || end < now + POLY_MIN_HOURS * 3600 * 1000 || end > now + POLY_MAX_DAYS * 86400 * 1000) continue;
      const q = String(m.question || '').trim();
      if (!q) continue;
      if (polyLooksLikeSports(q)) continue; // we already make sports markets ourselves
      const desc = String(m.description || '').replace(/\s+/g, ' ').trim().slice(0, 280);
      out.push({
        question: q,
        description: (desc ? desc + ' ' : '') + '\n\nMirrored from Polymarket (implied YES ' + Math.round(yes * 100) +
          '%, 24h volume $' + Math.round(vol24).toLocaleString('en-US') + '). Resolves to match Polymarket\u2019s official outcome.',
        category: classifyPoly(q),
        closesAt: end,
        auto: { provider: 'polymarket', id: String(m.id), conditionId: m.conditionId || null, slug: m.slug || null, endDate: end },
      });
      have.add(key);
    }
    return out;
  },
  async resolve(market) {
    const a = market.auto;
    let md;
    try { md = await fetchJson(POLY_GAMMA + '/markets/' + a.id); } catch (e) { return null; }
    if (!md || !md.closed) return null; // wait until Polymarket itself resolves
    const prices = parseJsonArr(md.outcomePrices).map(Number);
    const yes = prices[0];
    if (!isFinite(yes)) return null;
    if (yes >= 0.99) return 'YES';
    if (yes <= 0.01) return 'NO';
    return null; // voided / ambiguous — leave for admin
  },
};

// ── Sports provider (ESPN scoreboard, free, no key) ─────────────────────────
const SPORTS_LEAGUES = [
  { sport: 'soccer', league: 'fifa.world', label: 'World Cup' },
  { sport: 'soccer', league: 'eng.1', label: 'Premier League' },
  { sport: 'soccer', league: 'esp.1', label: 'La Liga' },
  { sport: 'soccer', league: 'ita.1', label: 'Serie A' },
  { sport: 'soccer', league: 'fra.1', label: 'Ligue 1' },
  { sport: 'soccer', league: 'ger.1', label: 'Bundesliga' },
  { sport: 'basketball', league: 'nba', label: 'NBA' },
  { sport: 'baseball', league: 'mlb', label: 'MLB' },
  { sport: 'hockey', league: 'nhl', label: 'NHL' },
];
const SPORTS_MAX_OPEN = Number(process.env.MARKET_AGENT_SPORTS_MAX) || 8;

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

// ── Soccer player-goals provider (ESPN, free) ───────────────────────────────
// "Will <star> score (1+/2+) vs <opp>?" — resolved from match goal events.
const GOALS_MAX_OPEN = Number(process.env.MARKET_AGENT_GOALS_MAX) || 10;
const GOALS_LEAGUES = SPORTS_LEAGUES.filter((l) => l.sport === 'soccer');

// Curated star strikers/attackers per team. Keys are normalized team names so
// lookup is tolerant of ESPN's exact spelling. Names need only be close enough
// for the accent-insensitive surname match used at resolution time.
const SUPERSTARS = {
  // National teams (World Cup)
  brazil: ['Vinicius Junior', 'Rodrygo'],
  argentina: ['Lionel Messi', 'Julian Alvarez'],
  france: ['Kylian Mbappe', 'Ousmane Dembele'],
  england: ['Harry Kane', 'Bukayo Saka'],
  portugal: ['Cristiano Ronaldo', 'Bruno Fernandes'],
  spain: ['Lamine Yamal', 'Alvaro Morata'],
  netherlands: ['Memphis Depay', 'Cody Gakpo'],
  germany: ['Kai Havertz', 'Jamal Musiala'],
  belgium: ['Romelu Lukaku', 'Kevin De Bruyne'],
  mexico: ['Santiago Gimenez', 'Raul Jimenez'],
  canada: ['Jonathan David', 'Alphonso Davies'],
  morocco: ['Youssef En-Nesyri', 'Hakim Ziyech'],
  'south korea': ['Son Heung-Min'],
  switzerland: ['Breel Embolo'],
  uruguay: ['Darwin Nunez'],
  croatia: ['Andrej Kramaric'],
  poland: ['Robert Lewandowski'],
  nigeria: ['Victor Osimhen'],
  egypt: ['Mohamed Salah'],
  norway: ['Erling Haaland'],
  scotland: ['Scott McTominay', 'John McGinn'],
  czechia: ['Patrik Schick'],
  ecuador: ['Enner Valencia'],
  'ivory coast': ['Sebastien Haller'],
  colombia: ['Luis Diaz'],
  senegal: ['Sadio Mane'],
  'united states': ['Christian Pulisic'],
  usa: ['Christian Pulisic'],
  // Clubs
  'real madrid': ['Kylian Mbappe', 'Vinicius Junior'],
  barcelona: ['Robert Lewandowski', 'Lamine Yamal'],
  'atletico madrid': ['Julian Alvarez', 'Antoine Griezmann'],
  'inter milan': ['Lautaro Martinez'],
  'ac milan': ['Rafael Leao'],
  juventus: ['Dusan Vlahovic'],
  napoli: ['Romelu Lukaku'],
  'paris saint-germain': ['Ousmane Dembele', 'Bradley Barcola'],
  'manchester city': ['Erling Haaland'],
  arsenal: ['Bukayo Saka'],
  liverpool: ['Mohamed Salah'],
  'manchester united': ['Bruno Fernandes'],
  tottenham: ['Son Heung-Min'],
  chelsea: ['Cole Palmer'],
  'bayern munich': ['Harry Kane'],
  'bayer leverkusen': ['Patrik Schick'],
  'borussia dortmund': ['Serhou Guirassy'],
};

function normName(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function nameMatch(a, b) {
  const p = normName(a), q = normName(b);
  if (!p || !q) return false;
  if (p === q) return true;
  const pl = p.split(' '), ql = q.split(' ');
  const ps = pl[pl.length - 1], qs = ql[ql.length - 1];
  return ps === qs && pl[0][0] === ql[0][0]; // same surname + same first initial
}
function lookupStars(teamDisplayName) {
  const n = normName(teamDisplayName);
  if (!n) return [];
  if (SUPERSTARS[n]) return SUPERSTARS[n];
  for (const key of Object.keys(SUPERSTARS)) {
    if (n.includes(key) || key.includes(n)) return SUPERSTARS[key];
  }
  return [];
}

const soccerGoalsProvider = {
  id: 'goals',
  enabled: process.env.MARKET_AGENT_GOALS !== '0',
  async generate(openAuto) {
    const open = openAuto.filter((m) => m.auto.provider === 'goals');
    if (open.length >= GOALS_MAX_OPEN) return [];
    const have = new Set(open.map((m) => m.auto.eventId + '|' + m.auto.player + '|' + m.auto.threshold));
    const out = [];
    const now = Date.now();
    const windowMs = 48 * 60 * 60 * 1000;
    const datesParam = ymd(new Date(now)) + '-' + ymd(new Date(now + windowMs));
    for (const lg of GOALS_LEAGUES) {
      if (open.length + out.length >= GOALS_MAX_OPEN) break;
      let data;
      try { data = await fetchScoreboard(lg, datesParam); } catch (e) { continue; }
      for (const ev of (data && data.events) || []) {
        if (open.length + out.length >= GOALS_MAX_OPEN) break;
        const state = ev.status && ev.status.type && ev.status.type.state;
        if (state !== 'pre') continue;
        const start = ev.date ? new Date(ev.date).getTime() : 0;
        if (!start || start < now || start > now + windowMs) continue;
        const p = parseCompetitors(ev);
        if (!p) continue;
        for (const side of [p.home, p.away]) {
          const other = side === p.home ? p.away : p.home;
          const teamName = side.team && (side.team.displayName || side.team.name);
          const oppName = other.team && (other.team.displayName || other.team.name);
          if (!teamName || !oppName) continue;
          const stars = lookupStars(teamName);
          for (const star of stars) {
            for (const thr of [1, 2]) {
              if (open.length + out.length >= GOALS_MAX_OPEN) break;
              if (have.has(ev.id + '|' + star + '|' + thr)) continue;
              const q = thr === 1
                ? 'Will ' + star + ' score for ' + teamName + ' vs ' + oppName + '?'
                : 'Will ' + star + ' score ' + thr + '+ goals (brace) vs ' + oppName + '?';
              out.push({
                question: q,
                description: lg.label + ': ' + teamName + ' vs ' + oppName + '. Starts ' + fmtUTC(start) +
                  '. Resolves YES if ' + star + ' scores ' + (thr === 1 ? 'at least once' : thr + ' or more goals') +
                  ' (own goals excluded).',
                category: 'Sports',
                closesAt: start,
                auto: { provider: 'goals', sport: lg.sport, league: lg.league, eventId: ev.id, player: star, threshold: thr, startAt: start },
              });
            }
          }
        }
      }
    }
    return out;
  },
  async resolve(market) {
    const a = market.auto;
    // wait until the match should be over (kickoff + ~2.5h) to avoid early reads
    if (Date.now() < a.startAt + 150 * 60 * 1000) return null;
    let sb;
    const datesParam = ymd(new Date(a.startAt)) + '-' + ymd(new Date(a.startAt + 24 * 60 * 60 * 1000));
    try { sb = await fetchScoreboard({ sport: a.sport, league: a.league }, datesParam); } catch (e) { return null; }
    const ev = ((sb && sb.events) || []).find((e) => e.id === a.eventId);
    if (!ev) return null;
    const st = ev.status && ev.status.type;
    if (!st || !st.completed) return null;
    let sd;
    try {
      sd = await fetchJson('https://site.api.espn.com/apis/site/v2/sports/' + a.sport + '/' + a.league + '/summary?event=' + a.eventId);
    } catch (e) { return null; }
    const events = (sd && sd.keyEvents) || [];
    if (!events.length) return null; // goal data not in yet — retry next tick
    let goals = 0;
    for (const k of events) {
      if (!k.scoringPlay) continue;
      if (/own goal/i.test((k.type && k.type.text) || '')) continue;
      const names = (k.participants || []).map((pp) => pp.athlete && pp.athlete.displayName).filter(Boolean);
      if (names.some((nm) => nameMatch(nm, a.player))) goals++;
    }
    return goals >= a.threshold ? 'YES' : 'NO';
  },
};

// ── LLM provider (web-search resolver for free-form markets) ────────────────
// Creates and resolves arbitrary news/politics/world/tech/business markets by
// asking a web-search LLM. Uses Perplexity (built for online search) if a key
// is present, otherwise OpenAI. Stays OFF entirely until a key is configured.
//
//   PERPLEXITY_API_KEY   preferred (model defaults to "sonar")
//   OPENAI_API_KEY       fallback (model defaults to "gpt-4o-search-preview")
//   LLM_MODEL            override the model name
//   LLM_AGENT=0          disable the whole LLM provider
//   LLM_AGENT_GENERATE=0 keep auto-resolution but stop auto-creating markets
//   LLM_MAX_OPEN         max concurrent open LLM markets (default 4)
//   LLM_CONFIDENCE       min confidence to auto-settle (default 0.75)
const LLM_PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
const LLM_OPENAI_KEY = process.env.OPENAI_API_KEY;
const LLM_ENABLED = process.env.LLM_AGENT !== '0' && !!(LLM_PERPLEXITY_KEY || LLM_OPENAI_KEY);
const LLM_GENERATE = process.env.LLM_AGENT_GENERATE !== '0';
const LLM_MAX_OPEN = Number(process.env.LLM_MAX_OPEN) || 4;
const LLM_CONFIDENCE = Number(process.env.LLM_CONFIDENCE) || 0.75;
const LLM_RECHECK_MS = 30 * 60 * 1000;

async function llmChat(messages, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let url, key, model;
    if (LLM_PERPLEXITY_KEY) {
      url = 'https://api.perplexity.ai/chat/completions';
      key = LLM_PERPLEXITY_KEY;
      model = process.env.LLM_MODEL || 'sonar';
    } else {
      url = 'https://api.openai.com/v1/chat/completions';
      key = LLM_OPENAI_KEY;
      model = process.env.LLM_MODEL || 'gpt-4o-search-preview';
    }
    const r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0.1 }),
    });
    if (!r.ok) throw new Error('LLM HTTP ' + r.status);
    const d = await r.json();
    return d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  } finally {
    clearTimeout(t);
  }
}

function parseJsonLoose(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.search(/[[{]/);
  if (s > 0) t = t.slice(s);
  try { return JSON.parse(t); } catch (e) { /* try trimming */ }
  const lastB = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (lastB > 0) { try { return JSON.parse(t.slice(0, lastB + 1)); } catch (e) { /* give up */ } }
  return null;
}

const llmProvider = {
  id: 'llm',
  enabled: LLM_ENABLED,
  async generate(openAuto) {
    if (!LLM_GENERATE) return [];
    const openLlm = openAuto.filter((m) => m.auto.provider === 'llm');
    const slots = LLM_MAX_OPEN - openLlm.length;
    if (slots <= 0) return [];
    const existing = openLlm.map((m) => '- ' + m.question).join('\n') || '(none)';
    const nowISO = new Date().toISOString();
    const prompt =
      'Today is ' + nowISO + '. Propose ' + slots + ' binary YES/NO prediction markets about real, upcoming, ' +
      'newsworthy events (politics, world affairs, technology, business, entertainment) that will be OBJECTIVELY ' +
      'resolvable within the next 2 to 7 days. Each must have an unambiguous resolution criterion and a specific ' +
      'resolution date. Avoid crypto prices and routine sports scores (handled elsewhere). Avoid anything similar to:\n' +
      existing + '\n\nReturn ONLY a JSON array, no prose: ' +
      '[{"question":"...","category":"Politics|World|Tech|Business|Entertainment","criteria":"exact condition that resolves YES","resolutionDate":"YYYY-MM-DD"}]';
    let txt;
    try { txt = await llmChat([{ role: 'user', content: prompt }]); } catch (e) { console.error('[agent] llm generate error:', e.message); return []; }
    const arr = parseJsonLoose(txt);
    if (!Array.isArray(arr)) return [];
    const out = [];
    const now = Date.now();
    const maxFuture = now + 10 * 24 * 60 * 60 * 1000;
    for (const it of arr) {
      if (out.length >= slots) break;
      if (!it || !it.question || !it.resolutionDate) continue;
      const day = new Date(it.resolutionDate + 'T00:00:00Z').getTime();
      if (isNaN(day) || day < now || day > maxFuture) continue;
      const resolveAt = day + 18 * 60 * 60 * 1000; // evening UTC on the resolution day
      out.push({
        question: String(it.question).slice(0, 180),
        description: (it.criteria ? 'Resolves YES if: ' + String(it.criteria).slice(0, 300) + ' ' : '') +
          '(Resolution date ' + it.resolutionDate + ', settled automatically from web sources.)',
        category: String(it.category || 'News').slice(0, 20),
        closesAt: day,
        auto: { provider: 'llm', resolveAt, criteria: String(it.criteria || it.question).slice(0, 300) },
      });
    }
    return out;
  },
  async resolve(market) {
    const a = market.auto;
    if (Date.now() < a.resolveAt) return null;
    if (a._lastCheck && Date.now() - a._lastCheck < LLM_RECHECK_MS) return null;
    a._lastCheck = Date.now();
    const prompt =
      'You are resolving a binary prediction market. Today is ' + new Date().toISOString() + '. Using current, ' +
      'verifiable web information, decide whether the statement has resolved YES or NO.\n\n' +
      'QUESTION: ' + market.question + '\n' +
      'RESOLUTION CRITERIA: ' + (a.criteria || market.description || market.question) + '\n\n' +
      'Rules: Only answer YES or NO if you are confident based on verifiable facts that have already occurred. ' +
      'If the event has not happened yet, is ambiguous, or cannot be verified, answer UNKNOWN. ' +
      'Respond with ONLY JSON: {"status":"YES|NO|UNKNOWN","confidence":0.0-1.0,"explanation":"one sentence with the key fact and date"}.';
    let txt;
    try { txt = await llmChat([{ role: 'user', content: prompt }]); } catch (e) { console.error('[agent] llm resolve error:', e.message); return null; }
    const j = parseJsonLoose(txt);
    if (!j) return null;
    const status = String(j.status || j.outcome || '').toUpperCase();
    const conf = Number(j.confidence || 0);
    if ((status === 'YES' || status === 'NO') && conf >= LLM_CONFIDENCE) {
      console.log('[agent] llm resolved', market.id, status, '(conf ' + conf + '):', String(j.explanation || '').slice(0, 140));
      return status;
    }
    console.log('[agent] llm undecided for', market.id, '- status', status, 'conf', conf, '— leaving for admin/retry');
    return null;
  },
};

const PROVIDERS = [cryptoProvider, sportsProvider, soccerGoalsProvider, weatherProvider, fngProvider, polymarketProvider, llmProvider].filter((p) => p.enabled);

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

module.exports = { start, fetchJson, _providers: { cryptoProvider, sportsProvider, soccerGoalsProvider, weatherProvider, fngProvider, polymarketProvider, llmProvider } };
