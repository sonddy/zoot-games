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

// Per-player history of vs-house results — used for matchmaking and abuse
// detection. Tracks recent outcomes AND bet sizes per wallet, so we can
// detect the classic "lose small, then bet big" drain pattern.
// Map<walletAddress, { results: [{outcome,bet,t}], lastAgentId, totalWon, totalLost, gamesPerHour:[t,...] }>
const playerHistory = new Map();
const MAX_HISTORY = 25;

function recordResult(walletAddress, outcome /* 'W' | 'L' | 'D' */, agentId, betAmount) {
  if (!walletAddress) return;
  let h = playerHistory.get(walletAddress);
  if (!h) {
    h = { results: [], lastAgentId: null, totalWon: 0, totalLost: 0, gamesPerHour: [] };
    playerHistory.set(walletAddress, h);
  }
  const bet = Number(betAmount) || 0;
  h.results.push({ outcome, bet, t: Date.now() });
  if (h.results.length > MAX_HISTORY) h.results.shift();
  if (outcome === 'W') h.totalWon += bet;
  else if (outcome === 'L') h.totalLost += bet;
  h.lastAgentId = agentId || h.lastAgentId;
  h.gamesPerHour.push(Date.now());
  h.gamesPerHour = h.gamesPerHour.filter(t => Date.now() - t < 3600 * 1000);
}

function getHistory(walletAddress) {
  return playerHistory.get(walletAddress) || null;
}

function getStreak(walletAddress) {
  const h = playerHistory.get(walletAddress);
  if (!h || h.results.length === 0) return { wins: 0, losses: 0, streak: 0, netWonZoot: 0 };
  const last5 = h.results.slice(-5);
  const wins   = last5.filter(r => r.outcome === 'W').length;
  const losses = last5.filter(r => r.outcome === 'L').length;
  let streak = 0;
  for (let i = h.results.length - 1; i >= 0; i--) {
    const r = h.results[i].outcome;
    if (r === 'D') break;
    if (streak >= 0 && r === 'W') streak++;
    else if (streak <= 0 && r === 'L') streak--;
    else break;
  }
  const netWonZoot = h.totalWon - h.totalLost;
  return { wins, losses, streak, lastAgentId: h.lastAgentId, netWonZoot, gamesLastHour: h.gamesPerHour.length };
}

// Pick an agent for the upcoming match.
//
// CRITICAL: this is a GAMBLING game — the matchmaking must NEVER reward a
// losing player with a weaker opponent. Previously a losing streak unlocked
// skill 1-2 agents, which is the classic "lose 3 small, then bet 100k vs a
// blunder bot" drain exploit. We now do the opposite: losing streaks raise
// the difficulty (assume the next bet may be larger), and ANY winning streak
// instantly pins to skill 5.
//
// `betAmount` (optional) lets us scale skill with stakes — small games can
// have a softer agent, but anything above the soft threshold always faces
// the sharks.
function pickAgent(walletAddress, betAmount) {
  const { streak, lastAgentId, netWonZoot } = getStreak(walletAddress);
  const bet = Number(betAmount) || 0;

  // ── Floor: bets above 5k ZOOT always face skill ≥ 4 ─────────────────
  let minSkill = 3;
  if (bet >= 5000) minSkill = 4;
  if (bet >= 20000) minSkill = 5;

  // Losing streaks RAISE skill (assume next bet escalates)
  if (streak <= -2) minSkill = Math.max(minSkill, 4);
  if (streak <= -3) minSkill = Math.max(minSkill, 5);

  // Winning streaks always face skill 5
  if (streak >= 1) minSkill = 5;

  // Players already net-up by 50k+ ZOOT vs the house: pin to skill 5
  if (netWonZoot >= 50000) minSkill = 5;

  let candidates = AGENTS.filter(a => a.skill >= minSkill);
  if (candidates.length === 0) candidates = AGENTS.filter(a => a.skill === 5);

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

// Reaction game: returns ms after the signal to "press".
// Humans average 250ms; world-class is 150ms. The bot should consistently
// out-react a typical human — even at skill 1.
function reactionDelayMs(agent) {
  const skillT = (agent.skill - 1) / 4; // 0..1
  // skill 1: 280ms / skill 5: 130ms — faster than virtually any human player
  const mean = lerp(280, 130, skillT);
  const v = jitter(mean, 35);
  // 1% chance of a fumble (slight stutter), capped small
  if (Math.random() < 0.01) return v + 220;
  return Math.max(110, personalityFactor(agent.personality, v));
}

// Math Duel: returns { solveTimeMs, willBeCorrect, errorMagnitude }
// A betting house's math bot should be ~always correct and fast.
function mathDuelPlan(agent) {
  const skillT = (agent.skill - 1) / 4;
  // skill 1: 3.0s / skill 5: 1.2s — usually faster than humans
  const meanSolve = lerp(3000, 1200, skillT);
  const solveTimeMs = Math.max(700, jitter(meanSolve, 600));
  // skill 1: 88% correct, skill 5: 99% correct
  const correctRate = lerp(0.88, 0.99, skillT);
  const willBeCorrect = Math.random() < correctRate;
  const maxErr = Math.round(lerp(8, 2, skillT));
  const errorMagnitude = willBeCorrect ? 0 : (Math.floor(Math.random() * maxErr) + 1);
  return { solveTimeMs: Math.round(personalityFactor(agent.personality, solveTimeMs)), willBeCorrect, errorMagnitude };
}

// Hi-Lo: returns 'higher' | 'lower' based on agent skill & current card.
// At skill 5 the agent plays optimally almost always; even skill 1 plays
// optimally most of the time (the math is trivial — there's no reason for
// a real degen bot to misplay it).
function hiloDecision(agent, currentCard) {
  const skillT = (agent.skill - 1) / 4;
  const optimalRate = lerp(0.85, 0.995, skillT);
  if (Math.random() < optimalRate && typeof currentCard === 'number') {
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
  const patternRate = lerp(0.0, 0.65, skillT); // chance to use pattern-detect
  const opts = ['rock', 'paper', 'scissors'];
  const counter = { rock: 'paper', paper: 'scissors', scissors: 'rock' };

  // Bluffer occasionally throws an obviously-bad-looking move
  if (agent.personality === 'bluffer' && Math.random() < 0.18) {
    return opts[Math.floor(Math.random() * 3)];
  }

  if (opponentHistory && opponentHistory.length > 0 && Math.random() < patternRate) {
    // Detect: did the opponent just play the same move twice? Counter the
    // expected third repeat. Else, counter their last move.
    const last = opponentHistory[opponentHistory.length - 1];
    const prev = opponentHistory.length >= 2 ? opponentHistory[opponentHistory.length - 2] : null;
    if (last && prev && last === prev) {
      // Counter the expected repeat — but humans often switch after 2-in-a-row,
      // so split: 60% counter the same, 40% counter their counter.
      if (Math.random() < 0.6) return counter[last];
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
  getHistory,
  reactionDelayMs,
  mathDuelPlan,
  hiloDecision,
  rpsDecision,
  thinkingDelay,
};
