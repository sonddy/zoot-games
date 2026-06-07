'use strict';

// ════════════════════════════════════════════════════════════════════
// HOUSE AGENT POOL
// Each agent is a virtual "opponent" players are matched against in
// vs-house mode. Players see the agent's displayName and walletDisplay
// instead of generic "House", so the lobby feels like real PvP.
//
// Skill drives behavior:
//   skill 1-2: weak (errors often, slow reactions, plays randomly)
//   skill 3-4: average (occasional mistakes, decent reaction)
//   skill 5  : sharp (fast, pattern-aware, rare mistakes)
//
// Personality colors the same skill in different ways:
//   aggressive: faster, occasionally over-commits (slightly more variance)
//   cautious:   slower, more consistent (slightly less variance)
//   bluffer:    intentional misdirection (RPS especially)
//   mixed:      mid-tempo, balanced
// ════════════════════════════════════════════════════════════════════

const AGENTS = [
  { id: 'agent_solshark',  displayName: 'solshark_42',     walletDisplay: '7nQ8...kRz3', avatar: '🦈', skill: 5, personality: 'aggressive', region: 'EU' },
  { id: 'agent_lunabet',   displayName: 'LunaBet',         walletDisplay: 'F3vL...mP9k', avatar: '🌙', skill: 4, personality: 'cautious',   region: 'NA' },
  { id: 'agent_crypape',   displayName: 'crypto_ape_99',   walletDisplay: '9Hd2...rQ7w', avatar: '🦍', skill: 4, personality: 'bluffer',    region: 'NA' },
  { id: 'agent_moonlight', displayName: 'moonlight',       walletDisplay: 'D4jK...nT8v', avatar: '✨', skill: 3, personality: 'mixed',      region: 'AS' },
  { id: 'agent_dgenchad',  displayName: 'dGenChad',        walletDisplay: 'Q5xR...bF1p', avatar: '🎰', skill: 3, personality: 'aggressive', region: 'NA' },
  { id: 'agent_riskoff',   displayName: 'RiskOff_xyz',     walletDisplay: '8vGm...cH4t', avatar: '📉', skill: 2, personality: 'cautious',   region: 'EU' },
  { id: 'agent_pixelpup',  displayName: 'pixel.pup',       walletDisplay: 'A2nB...wL6r', avatar: '🐶', skill: 2, personality: 'mixed',      region: 'SA' },
  { id: 'agent_lucky',     displayName: '0xLucky',         walletDisplay: 'M7sE...yU3j', avatar: '🍀', skill: 1, personality: 'bluffer',    region: 'OC' },
];

const AGENT_BY_ID = new Map(AGENTS.map(a => [a.id, a]));

// Per-player history of vs-house results — used for streak-based matchmaking.
// Only kept in memory; resets on server restart (intentional — we don't want
// a player who lost yesterday to be permanently matched with weak agents).
// Map<walletAddress, { results: ['W','L','D', ...], lastAgentId: string }>
const playerHistory = new Map();
const MAX_HISTORY = 10;

function recordResult(walletAddress, outcome /* 'W' | 'L' | 'D' */, agentId) {
  if (!walletAddress) return;
  let h = playerHistory.get(walletAddress);
  if (!h) { h = { results: [], lastAgentId: null }; playerHistory.set(walletAddress, h); }
  h.results.push(outcome);
  if (h.results.length > MAX_HISTORY) h.results.shift();
  h.lastAgentId = agentId || h.lastAgentId;
}

function getStreak(walletAddress) {
  const h = playerHistory.get(walletAddress);
  if (!h || h.results.length === 0) return { wins: 0, losses: 0, streak: 0 };
  const last5 = h.results.slice(-5);
  const wins = last5.filter(r => r === 'W').length;
  const losses = last5.filter(r => r === 'L').length;
  // streak: positive for winning streak, negative for losing streak
  let streak = 0;
  for (let i = h.results.length - 1; i >= 0; i--) {
    const r = h.results[i];
    if (r === 'D') break;
    if (streak >= 0 && r === 'W') streak++;
    else if (streak <= 0 && r === 'L') streak--;
    else break;
  }
  return { wins, losses, streak, lastAgentId: h.lastAgentId };
}

// Pick an agent for the upcoming match based on the player's recent history.
//
// HARD MODE matchmaking: default opponents are skill 4-5. Losing players get
// brief relief at skill 3, but we never assign skill 1-2 anymore — the lobby
// should feel like every opponent knows what they're doing.
//
// Always avoid repeating the same agent two games in a row when possible —
// the lobby should feel like a rotating pool of opponents, not one bot.
function pickAgent(walletAddress) {
  const { streak, lastAgentId } = getStreak(walletAddress);

  let candidates;
  if (streak >= 1)       candidates = AGENTS.filter(a => a.skill === 5);     // winning → pure shark
  else if (streak <= -4) candidates = AGENTS.filter(a => a.skill === 3);     // big losing streak → mid-tier relief
  else                   candidates = AGENTS.filter(a => a.skill >= 4);      // default: skill 4-5 only

  // Try not to repeat the last opponent.
  const filtered = candidates.filter(a => a.id !== lastAgentId);
  const pool = filtered.length > 0 ? filtered : candidates;

  return pool[Math.floor(Math.random() * pool.length)];
}

function getAgentById(id) { return AGENT_BY_ID.get(id) || null; }

// ════════════════════════════════════════════════════════════════════
// SKILL-DRIVEN BEHAVIORAL CURVES
// ════════════════════════════════════════════════════════════════════

function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }
function jitter(mean, spread) {
  // Gaussian-ish jitter via two uniform draws (Bates-2). Spread is +/- range.
  const u = (Math.random() + Math.random()) / 2 - 0.5;
  return mean + u * spread * 2;
}
function personalityFactor(personality, base) {
  switch (personality) {
    case 'aggressive': return base * 0.85;  // ~15% faster
    case 'cautious':   return base * 1.15;  // ~15% slower
    case 'bluffer':    return base * 1.0 + (Math.random() < 0.15 ? 800 : 0); // occasional long pause
    case 'mixed':
    default:           return base;
  }
}

// Reaction game: returns ms after the signal to "press"
function reactionDelayMs(agent) {
  const skillT = (agent.skill - 1) / 4; // 0..1
  // HARD MODE: skill 5 ~150ms (faster than most humans); skill 1 ~380ms.
  const mean = lerp(380, 150, skillT);
  const v = jitter(mean, 60);
  // Fumble chance heavily reduced for high skill (0% at skill 5)
  const fumbleRate = lerp(0.05, 0.0, skillT);
  if (Math.random() < fumbleRate) return v + 400;
  return Math.max(110, personalityFactor(agent.personality, v));
}

// Math Duel: returns { solveTimeMs, willBeCorrect, errorMagnitude }
function mathDuelPlan(agent) {
  const skillT = (agent.skill - 1) / 4;
  // HARD MODE: skill 5 solves in ~1.3s and is correct 98% of the time.
  const meanSolve = lerp(3800, 1300, skillT);
  const solveTimeMs = Math.max(800, jitter(meanSolve, 800));
  const correctRate = lerp(0.65, 0.98, skillT);
  const willBeCorrect = Math.random() < correctRate;
  // Errors are smaller for higher-skill agents (they slip on one digit, not far off)
  const maxErr = Math.round(lerp(10, 2, skillT));
  const errorMagnitude = willBeCorrect ? 0 : (Math.floor(Math.random() * maxErr) + 1);
  return { solveTimeMs: Math.round(personalityFactor(agent.personality, solveTimeMs)), willBeCorrect, errorMagnitude };
}

// Hi-Lo: returns 'higher' | 'lower' based on agent skill & current card.
// At skill 5, near-optimal play given card 1-13. At skill 1, mostly random.
function hiloDecision(agent, currentCard) {
  const skillT = (agent.skill - 1) / 4;
  // HARD MODE: skill 5 plays optimally 99% of the time; skill 1 = 70%.
  const optimalRate = lerp(0.70, 0.99, skillT);
  if (Math.random() < optimalRate && typeof currentCard === 'number') {
    // Cards 1-7 → 'higher' is optimal; 8-13 → 'lower' is optimal; 7 is coinflip.
    if (currentCard < 7)  return 'higher';
    if (currentCard > 7)  return 'lower';
    return Math.random() < 0.5 ? 'higher' : 'lower';
  }
  return Math.random() < 0.5 ? 'higher' : 'lower';
}

// RPS: pattern-aware at higher skill. opponentHistory is an array of the
// player's previous picks across the BO3 ('rock'|'paper'|'scissors'|null).
function rpsDecision(agent, opponentHistory) {
  const skillT = (agent.skill - 1) / 4;
  // HARD MODE: skill 5 reads patterns 90% of the time; skill 1 = 30%.
  const patternRate = lerp(0.30, 0.90, skillT);
  const opts = ['rock', 'paper', 'scissors'];
  const counter = { rock: 'paper', paper: 'scissors', scissors: 'rock' };

  // Bluffer occasionally throws an obviously-bad-looking move (reduced freq)
  if (agent.personality === 'bluffer' && Math.random() < 0.08) {
    return opts[Math.floor(Math.random() * 3)];
  }

  if (opponentHistory && opponentHistory.length > 0 && Math.random() < patternRate) {
    // Detect: did the opponent just play the same move twice? Counter the
    // expected third repeat. Else, counter their last move.
    const last = opponentHistory[opponentHistory.length - 1];
    const prev = opponentHistory.length >= 2 ? opponentHistory[opponentHistory.length - 2] : null;
    if (last && prev && last === prev) {
      // Counter the expected repeat — but humans often switch after 2-in-a-row,
      // so split: 70% counter the same, 30% counter their counter.
      if (Math.random() < 0.7) return counter[last];
      return counter[counter[last]];
    }
    if (last) return counter[last];
  }
  return opts[Math.floor(Math.random() * 3)];
}

// Thinking delay (ms) before any visible action. Faster at higher skill,
// modulated by personality. Game-type specific bases.
function thinkingDelay(agent, gameType, game) {
  const skillT = (agent.skill - 1) / 4;
  const baseByGame = {
    rps:        lerp(2200, 800,  skillT),
    coinflip:   lerp(1400, 700,  skillT),
    diceduel:   lerp(1600, 700,  skillT),
    hilo:       lerp(2400, 900,  skillT),
    mathduel:   0, // handled by mathDuelPlan
    reaction:   0, // handled by reactionDelayMs
    war:        lerp(1400, 600,  skillT),
    tictactoe:  lerp(1800, 700,  skillT),
    morpion:    lerp(2400, 1000, skillT),
    connect4:   lerp(2400, 900,  skillT),
    dotsboxes:  lerp(2000, 900,  skillT),
    nim:        lerp(1900, 800,  skillT),
    hex:        lerp(3000, 1200, skillT),
    checkers:   lerp(3500, 1500, skillT),
    chess:      lerp(5000, 2200, skillT),
    reversi:    lerp(3000, 1300, skillT),
    mancala:    lerp(2600, 1100, skillT),
    backgammon: lerp(3500, 1400, skillT),
    domino:     lerp(2800, 1200, skillT),
    speed:      lerp(1200, 500,  skillT),
    memory:     lerp(2600, 1100, skillT),
    battleship: lerp(3000, 1300, skillT),
    poker:      lerp(4000, 1600, skillT),
  };
  const base = baseByGame[gameType] ?? 1200;
  const ms = jitter(base, base * 0.35);
  return Math.max(300, Math.round(personalityFactor(agent.personality, ms)));
}

module.exports = {
  AGENTS,
  pickAgent,
  getAgentById,
  recordResult,
  getStreak,
  reactionDelayMs,
  mathDuelPlan,
  hiloDecision,
  rpsDecision,
  thinkingDelay,
};
