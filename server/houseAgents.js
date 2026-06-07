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

// Pick an agent for the upcoming vs-house match.
//
// IMPORTANT: Earlier versions of this matchmaker selected weaker agents for
// players on a losing streak (a friendly "rubber-banding" feature). That was
// exploited as a draining vector — a player could intentionally lose 3 small
// games to face skill-1 agents, then bet big and farm easy wins.
//
// Therefore every vs-house match is now a SKILL-5 agent. We still rotate
// the *displayed* persona (avatar / name / fake wallet) so the lobby keeps
// its variety, but the actual decision-making skill is always max.
function pickAgent(walletAddress) {
  const { lastAgentId } = getStreak(walletAddress);

  // Pick a display persona at random; rotate names to keep the lobby varied.
  const personas = AGENTS.filter(a => a.id !== lastAgentId);
  const pool = personas.length > 0 ? personas : AGENTS;
  const persona = pool[Math.floor(Math.random() * pool.length)];

  // Return a COPY with skill forced to 5 and an aggressive personality
  // (slightly faster reactions). This prevents weak skills regardless of
  // which name the player sees.
  return {
    ...persona,
    skill: 5,
    personality: 'aggressive',
  };
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
//
// At skill 5 the bot is effectively SUPERHUMAN — sub-200ms reaction every
// time. The fastest human pro gamers average ~170-200ms on visual reaction
// tests, so a 140-170ms bot wins ~95% of human matches. The 1.94x payout
// covers the remaining ~5%.
function reactionDelayMs(agent) {
  const skillT = (agent.skill - 1) / 4; // 0..1
  // skill 1: 480ms / skill 5: 150ms (superhuman vs. ~250ms typical human)
  const mean = lerp(480, 150, skillT);
  const spread = lerp(90, 25, skillT);    // skill 5 has tight, consistent timing
  const v = jitter(mean, spread);
  // Skill 5: no fumbles. Lower skill: occasional misses.
  const fumbleChance = agent.skill >= 5 ? 0 : 0.02;
  const fumble = Math.random() < fumbleChance ? 600 : 0;
  const floor = agent.skill >= 5 ? 110 : 120;
  return Math.max(floor, personalityFactor(agent.personality, v + fumble));
}

// Math Duel: returns { solveTimeMs, willBeCorrect, errorMagnitude }.
//
// At skill 5 the bot answers correctly EVERY TIME in ~900-1300ms — a human
// solving a small arithmetic problem typically needs 2-4s and makes the
// occasional digit slip. The 1.94x payout protects against the rare tie.
function mathDuelPlan(agent) {
  const skillT = (agent.skill - 1) / 4;
  const meanSolve = lerp(4500, 1100, skillT);
  const spread = lerp(1100, 250, skillT);
  const solveTimeMs = Math.max(800, jitter(meanSolve, spread));
  // Skill 5: ALWAYS correct. Lower skills sometimes slip.
  const correctRate = agent.skill >= 5 ? 1.0 : lerp(0.50, 0.88, skillT);
  const willBeCorrect = Math.random() < correctRate;
  const maxErr = Math.round(lerp(12, 4, skillT));
  const errorMagnitude = willBeCorrect ? 0 : (Math.floor(Math.random() * maxErr) + 1);
  return { solveTimeMs: Math.round(personalityFactor(agent.personality, solveTimeMs)), willBeCorrect, errorMagnitude };
}

// Hi-Lo: returns 'higher' | 'lower' based on agent skill & current card.
//
// At skill 5 the bot plays OPTIMALLY every turn. A player going against the
// bot at 1.94x payout has a slight negative expectation per round (the
// optimal play wins ~7/13 = ~54% on average across all cards).
function hiloDecision(agent, currentCard) {
  const skillT = (agent.skill - 1) / 4;
  const optimalRate = agent.skill >= 5 ? 1.0 : lerp(0.5, 0.95, skillT);
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
    // Speed is real-time — at skill 5 we need to be fast enough to win the
    // hand-clear race against fast humans (and scripted clients). 180ms per
    // play clears a 21-card hand in <4s; humans rarely beat 6-8s.
    speed:      lerp(700,  180,  skillT),
    // Memory: at skill 5 the bot has perfect recall (see memoryMove). With
    // ~600ms thinking the bot still has lots of "personality" but won't
    // be out-paced by a scripted memorizer.
    memory:     lerp(1800, 600,  skillT),
    battleship: lerp(3000, 1300, skillT),
    poker:      lerp(4000, 1600, skillT),
  };
  const base = baseByGame[gameType] ?? 1200;
  const ms = jitter(base, base * 0.35);
  // Floor: skill 5 in fast games (speed/memory) can dip to 120ms.
  const floor = (agent.skill >= 5 && (gameType === 'speed' || gameType === 'memory')) ? 120 : 300;
  return Math.max(floor, Math.round(personalityFactor(agent.personality, ms)));
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
