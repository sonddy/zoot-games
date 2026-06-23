'use strict';

// ════════════════════════════════════════════════════════════════════
// HOUSE STRATEGY
// Game-specific heuristics for the live agents. Each function takes
// (game, housePlayerIndex, agent) and returns either:
//   - { action: {...} } : a specific move to play via game.handleAction
//   - { fallback: true }: no opinion, defer to game.autoPlayForTimeout
//
// Skill-modulated mistake rate: even skill-5 agents intentionally
// blunder occasionally so wins still feel earned.
// ════════════════════════════════════════════════════════════════════

function mistakeChance(skill) {
  // SKILL 5: NEVER blunders. vs-house always uses skill 5 now — the house
  // cannot afford random self-sabotage at the top level.
  // skill 4 -> 0.05  skill 3 -> 0.16  skill 2 -> 0.27  skill 1 -> 0.38
  if (skill >= 5) return 0;
  return Math.max(0, 0.5 - 0.11 * skill);
}

function shouldBlunder(agent) {
  return Math.random() < mistakeChance((agent && agent.skill) || 3);
}

// ──────────────────────────────────────────────────────────────
// MORPION (15x15 Gomoku, 5-in-a-row)
// ──────────────────────────────────────────────────────────────
//
// Heuristic: for each empty cell near existing play, compute a score
// equal to (my pattern strength) + defensiveWeight * (opponent strength).
// Picks the highest-scoring cell, with a small skill-based blunder rate.

// Score (in a single direction line) after placing a stone at the cell
// for `me`. We look 4 cells each way from the placed stone to count
// stones-in-a-row and open ends.
function _lineScoreAt(board, size, cell, dr, dc, me, opp) {
  const r0 = Math.floor(cell / size);
  const c0 = cell % size;

  // Count consecutive `me` stones extending forward
  let forward = 0;
  let frFree = true;
  for (let s = 1; s < 5; s++) {
    const nr = r0 + dr * s, nc = c0 + dc * s;
    if (nr < 0 || nr >= size || nc < 0 || nc >= size) { frFree = false; break; }
    const v = board[nr * size + nc];
    if (v === me) forward++;
    else { frFree = (v === null); break; }
  }
  // Count consecutive `me` stones extending backward
  let backward = 0;
  let bkFree = true;
  for (let s = 1; s < 5; s++) {
    const nr = r0 - dr * s, nc = c0 - dc * s;
    if (nr < 0 || nr >= size || nc < 0 || nc >= size) { bkFree = false; break; }
    const v = board[nr * size + nc];
    if (v === me) backward++;
    else { bkFree = (v === null); break; }
  }

  const inARow = 1 + forward + backward;       // includes the placed stone
  const openEnds = (frFree ? 1 : 0) + (bkFree ? 1 : 0);

  if (inARow >= 5) return 100000;
  if (inARow === 4) {
    if (openEnds === 2) return 10000;          // open 4 - immediate winning threat
    if (openEnds === 1) return 1000;           // half-open 4
    return 0;
  }
  if (inARow === 3) {
    if (openEnds === 2) return 500;            // open 3
    if (openEnds === 1) return 100;            // half-open 3
    return 0;
  }
  if (inARow === 2) {
    if (openEnds === 2) return 50;
    if (openEnds === 1) return 10;
    return 0;
  }
  return openEnds; // 1-in-a-row, barely worth anything
}

function _cellScore(board, size, cell, me, opp) {
  if (board[cell] !== null) return -Infinity;
  let myScore = 0, oppScore = 0;
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    myScore  += _lineScoreAt(board, size, cell, dr, dc, me,  opp);
    oppScore += _lineScoreAt(board, size, cell, dr, dc, opp, me);
  }
  return { myScore, oppScore };
}

function morpionMove(game, idx, agent) {
  const board = game.board;
  const size = game.size;
  const me = idx;
  const opp = 1 - idx;
  const total = size * size;

  // Empty board: play center
  if (game.moveCount === 0) {
    const c = Math.floor(size / 2);
    return { action: { type: 'place', cell: c * size + c } };
  }

  // Candidate cells: only empties within 2 steps of any existing stone
  // (Gomoku always plays near contact; pruning makes this O(boardSize) not O(total))
  const candidates = new Set();
  for (let i = 0; i < total; i++) {
    if (board[i] === null) continue;
    const r = Math.floor(i / size), c = i % size;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        const ni = nr * size + nc;
        if (board[ni] === null) candidates.add(ni);
      }
    }
  }
  if (candidates.size === 0) return { fallback: true };

  // Skill-based defensive weight: skill 5 blocks hard, skill 1 barely cares
  const skill = (agent && agent.skill) || 3;
  const defensiveWeight = 0.4 + 0.12 * skill; // skill 5 -> 1.0, skill 1 -> 0.52

  let best = null;
  const ranked = [];
  for (const cell of candidates) {
    const s = _cellScore(board, size, cell, me, opp);
    if (s === -Infinity) continue;
    const total = s.myScore + s.oppScore * defensiveWeight;
    ranked.push({ cell, total, myScore: s.myScore, oppScore: s.oppScore });
    if (!best || total > best.total) best = { cell, total };
  }

  if (!best) return { fallback: true };

  ranked.sort((a, b) => b.total - a.total);
  const place = (cell) => ({ action: { type: 'place', cell } });

  // ── Hard threat-priority ladder (overrides the skill-modulated score). ──
  // These are the moves that, if missed, lose a game the house should win.
  // The old code only force-blocked an OPEN FOUR (>=10000) — but an open four
  // is already an unstoppable double-ended threat (you can only block one end).
  // By the time the opponent has one it's too late. The fix is to react to
  // threats *one tier earlier*: take/own forcing fours, and block open threes
  // BEFORE they mature into an open four.
  //
  // Score legend (per _lineScoreAt): five=100000, open-4=10000, half-open-4=1000,
  // open-3=500, half-open-3=100. myScore/oppScore are summed across directions,
  // so a cell that creates two open threes ("double-three" fork) scores ~1000+
  // and is correctly treated as a winning move.

  // 1. Win now: complete five-in-a-row.
  for (const r of ranked) if (r.myScore >= 100000) return place(r.cell);
  // 2. Block the opponent's immediate five.
  for (const r of ranked) if (r.oppScore >= 100000) return place(r.cell);
  // 3. Make my own open four — unstoppable next turn.
  for (const r of ranked) if (r.myScore >= 10000) return place(r.cell);
  // 4. Block the opponent's open four.
  for (const r of ranked) if (r.oppScore >= 10000) return place(r.cell);
  // 5. Make a forcing four (or a double-three fork) to seize the initiative.
  for (const r of ranked) if (r.myScore >= 1000) return place(r.cell);
  // 6. Block the opponent's forcing four / would-be four.
  for (const r of ranked) if (r.oppScore >= 1000) return place(r.cell);
  // 7. Block the opponent's open three before it becomes an open four — unless
  //    we have an equally-or-more threatening developing move of our own.
  for (const r of ranked) if (r.oppScore >= 500 && r.myScore < r.oppScore) return place(r.cell);

  // Skill-based blunder: pick a sub-optimal move from the top-N occasionally.
  // (skill 5 — every vs-house agent — never blunders; mistakeChance(5) === 0.)
  if (shouldBlunder(agent)) {
    const topN = Math.min(ranked.length, 6);
    const pick = ranked[Math.floor(Math.random() * topN)];
    return { action: { type: 'place', cell: pick.cell } };
  }

  // ── Skill-5 tactical verification (2-ply). ──
  // The 1-ply score can walk into traps: a move may LOOK strong but hand the
  // opponent a forcing reply, or miss that a slightly lower-scored cell sets
  // up an unanswerable double threat. For the top candidates, simulate my
  // stone, find the opponent's best reply (same scorer), and pick the move
  // with the best worst-case outcome. Bounded by candidate caps, so cost is
  // ~16 × 8 cell evaluations — fast.
  if (skill >= 5 && ranked.length > 1) {
    const deadline = Date.now() + 250;
    const myTop = ranked.slice(0, 16);
    let bestCell = best.cell;
    let bestVal = -Infinity;
    for (const cand of myTop) {
      if (Date.now() > deadline) break;
      board[cand.cell] = me;

      // Opponent's best reply over cells near the action.
      let oppBest = 0;     // opponent's strongest attacking reply
      let myFollow = 0;    // my strongest follow-up if opponent must defend
      const reply = [];
      for (const other of myTop) {
        if (other.cell === cand.cell || board[other.cell] !== null) continue;
        reply.push(other.cell);
      }
      // Also rescore the candidate's neighbors (the move changes local scores).
      const r0 = Math.floor(cand.cell / size), c0 = cand.cell % size;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const nr = r0 + dr, nc = c0 + dc;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        const ni = nr * size + nc;
        if (board[ni] === null && !reply.includes(ni)) reply.push(ni);
      }
      for (const rc of reply.slice(0, 24)) {
        const s = _cellScore(board, size, rc, opp, me);
        if (s === -Infinity) continue;
        if (s.myScore > oppBest) oppBest = s.myScore;   // from opp's perspective
        if (s.oppScore > myFollow) myFollow = s.oppScore; // my threat they'd have to answer
      }
      board[cand.cell] = null;

      // Value: my immediate gain + my follow-up pressure − what I allow the
      // opponent to build in reply.
      const val = cand.myScore + cand.oppScore * defensiveWeight + myFollow * 0.45 - oppBest * 0.9;
      if (val > bestVal) { bestVal = val; bestCell = cand.cell; }
    }
    return place(bestCell);
  }

  return place(best.cell);
}

// ──────────────────────────────────────────────────────────────
// TIC TAC TOE — minimax (perfect play; with blunder rate it's still beatable)
// ──────────────────────────────────────────────────────────────

function _tttWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  for (const [a, b, c] of lines) {
    if (board[a] !== null && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  if (board.every(v => v !== null)) return 'draw';
  return null;
}

function _tttMinimax(board, current, me, opp, depth) {
  depth = depth || 0;
  const w = _tttWinner(board);
  // Depth-weighted scoring: prefer FASTER wins, SLOWER losses. This matters
  // when all our moves lose to optimal play — we'd rather force the opponent
  // through more moves (and they might blunder along the way) than walk into
  // the loss immediately.
  if (w === me)   return { score:  100 - depth };
  if (w === opp)  return { score: -100 + depth };
  if (w === 'draw') return { score: 0 };

  const isMax = (current === me);
  let best = { score: isMax ? -Infinity : Infinity, move: null };
  for (let i = 0; i < 9; i++) {
    if (board[i] !== null) continue;
    board[i] = current;
    const next = _tttMinimax(board, current === me ? opp : me, me, opp, depth + 1);
    board[i] = null;
    if (isMax ? next.score > best.score : next.score < best.score) {
      best = { score: next.score, move: i };
    }
  }
  return best;
}

function tttMove(game, idx, agent) {
  // TTT can be 3x3 (size 3) or larger (5x5, 7x7) with win-length 4.
  // Minimax is only tractable for 3x3; for larger boards, defer to the
  // game's already-decent autoplay (which does win-detection + blocking).
  if (game.size && game.size !== 3) return { fallback: true };

  const board = game.board.slice();
  if (board.length !== 9) return { fallback: true };
  const me = idx;
  const opp = 1 - idx;
  const skill = (agent && agent.skill) || 3;

  function emptiesOf(b) {
    const e = [];
    for (let i = 0; i < 9; i++) if (b[i] === null) e.push(i);
    return e;
  }

  // ALWAYS take an immediate win or block an immediate loss, regardless of
  // skill or blunder rate. This is what makes the agent feel competent —
  // humans hate it when their obvious 2-in-a-row goes unblocked.
  const empties = emptiesOf(board);
  if (empties.length === 0) return { fallback: true };
  for (const i of empties) {
    board[i] = me;
    const wmeWin = _tttWinner(board);
    board[i] = null;
    if (wmeWin === me) return { action: { type: 'place', cell: i } };
  }
  for (const i of empties) {
    board[i] = opp;
    const wOppWin = _tttWinner(board);
    board[i] = null;
    if (wOppWin === opp) return { action: { type: 'place', cell: i } };
  }

  // Low-skill agents play randomly often
  if (skill <= 2 && Math.random() < 0.6) {
    return { action: { type: 'place', cell: empties[Math.floor(Math.random() * empties.length)] } };
  }
  // skill 3: ~20% blunder; skill 4: ~10%; skill 5: ~5%
  const blunderRate = Math.max(0.05, 0.4 - 0.08 * skill);
  if (Math.random() < blunderRate) {
    return { action: { type: 'place', cell: empties[Math.floor(Math.random() * empties.length)] } };
  }

  const result = _tttMinimax(board, me, me, opp, 0);
  if (result.move === null) return { fallback: true };
  return { action: { type: 'place', cell: result.move } };
}

// ──────────────────────────────────────────────────────────────
// CONNECT 4 — minimax with depth scaled by skill
// ──────────────────────────────────────────────────────────────

const C4_ROWS = 6, C4_COLS = 7;

function _c4DropRow(board, col) {
  for (let r = C4_ROWS - 1; r >= 0; r--) {
    if (board[r * C4_COLS + col] === null) return r;
  }
  return -1;
}
function _c4Winner(board) {
  // horizontal
  for (let r = 0; r < C4_ROWS; r++) {
    for (let c = 0; c <= C4_COLS - 4; c++) {
      const v = board[r * C4_COLS + c];
      if (v !== null && v === board[r * C4_COLS + c + 1] && v === board[r * C4_COLS + c + 2] && v === board[r * C4_COLS + c + 3]) return v;
    }
  }
  // vertical
  for (let c = 0; c < C4_COLS; c++) {
    for (let r = 0; r <= C4_ROWS - 4; r++) {
      const v = board[r * C4_COLS + c];
      if (v !== null && v === board[(r + 1) * C4_COLS + c] && v === board[(r + 2) * C4_COLS + c] && v === board[(r + 3) * C4_COLS + c]) return v;
    }
  }
  // diagonals
  for (let r = 0; r <= C4_ROWS - 4; r++) {
    for (let c = 0; c <= C4_COLS - 4; c++) {
      const v = board[r * C4_COLS + c];
      if (v !== null && v === board[(r + 1) * C4_COLS + c + 1] && v === board[(r + 2) * C4_COLS + c + 2] && v === board[(r + 3) * C4_COLS + c + 3]) return v;
    }
  }
  for (let r = 3; r < C4_ROWS; r++) {
    for (let c = 0; c <= C4_COLS - 4; c++) {
      const v = board[r * C4_COLS + c];
      if (v !== null && v === board[(r - 1) * C4_COLS + c + 1] && v === board[(r - 2) * C4_COLS + c + 2] && v === board[(r - 3) * C4_COLS + c + 3]) return v;
    }
  }
  if (board.every(v => v !== null)) return 'draw';
  return null;
}
// Cheap evaluation: count threats of each player
function _c4Eval(board, me, opp) {
  const score = (player) => {
    let s = 0;
    const lines = [];
    // build all 4-cell windows
    for (let r = 0; r < C4_ROWS; r++)
      for (let c = 0; c <= C4_COLS - 4; c++)
        lines.push([r * C4_COLS + c, r * C4_COLS + c + 1, r * C4_COLS + c + 2, r * C4_COLS + c + 3]);
    for (let c = 0; c < C4_COLS; c++)
      for (let r = 0; r <= C4_ROWS - 4; r++)
        lines.push([r * C4_COLS + c, (r + 1) * C4_COLS + c, (r + 2) * C4_COLS + c, (r + 3) * C4_COLS + c]);
    for (let r = 0; r <= C4_ROWS - 4; r++)
      for (let c = 0; c <= C4_COLS - 4; c++)
        lines.push([r * C4_COLS + c, (r + 1) * C4_COLS + c + 1, (r + 2) * C4_COLS + c + 2, (r + 3) * C4_COLS + c + 3]);
    for (let r = 3; r < C4_ROWS; r++)
      for (let c = 0; c <= C4_COLS - 4; c++)
        lines.push([r * C4_COLS + c, (r - 1) * C4_COLS + c + 1, (r - 2) * C4_COLS + c + 2, (r - 3) * C4_COLS + c + 3]);
    for (const line of lines) {
      let mine = 0, theirs = 0;
      for (const i of line) {
        if (board[i] === player) mine++;
        else if (board[i] !== null) theirs++;
      }
      if (theirs > 0) continue;
      if (mine === 4) s += 1000;
      else if (mine === 3) s += 50;
      else if (mine === 2) s += 5;
    }
    return s;
  };
  return score(me) - score(opp);
}
const C4_TIMEOUT = { timeout: true };
function _c4Minimax(board, current, me, opp, depth, alpha, beta, deadline) {
  if (deadline && Date.now() > deadline) throw C4_TIMEOUT;
  const w = _c4Winner(board);
  if (w === me)   return { score: 100000 - (10 - depth) }; // prefer faster wins
  if (w === opp)  return { score: -100000 + (10 - depth) };
  if (w === 'draw') return { score: 0 };
  if (depth === 0) return { score: _c4Eval(board, me, opp) };

  const isMax = (current === me);
  let best = { score: isMax ? -Infinity : Infinity, move: null };
  // search center columns first for better pruning
  const order = [3, 2, 4, 1, 5, 0, 6];
  for (const col of order) {
    const row = _c4DropRow(board, col);
    if (row < 0) continue;
    const idx = row * C4_COLS + col;
    board[idx] = current;
    const nxt = _c4Minimax(board, current === me ? opp : me, me, opp, depth - 1, alpha, beta, deadline);
    board[idx] = null;
    if (isMax) {
      if (nxt.score > best.score) best = { score: nxt.score, move: col };
      alpha = Math.max(alpha, best.score);
    } else {
      if (nxt.score < best.score) best = { score: nxt.score, move: col };
      beta = Math.min(beta, best.score);
    }
    if (alpha >= beta) break;
  }
  return best;
}
function c4Move(game, idx, agent) {
  // game.board is a 2D array [row][col]; flatten for minimax.
  let board;
  if (Array.isArray(game.board) && game.board.length === C4_ROWS && Array.isArray(game.board[0])) {
    board = [];
    for (let r = 0; r < C4_ROWS; r++)
      for (let c = 0; c < C4_COLS; c++)
        board.push(game.board[r][c] === undefined ? null : game.board[r][c]);
  } else if (Array.isArray(game.board) && game.board.length === C4_ROWS * C4_COLS) {
    board = game.board.slice();
  } else {
    return { fallback: true };
  }
  const me = idx;
  const opp = 1 - idx;
  const skill = (agent && agent.skill) || 3;

  // blunder
  if (Math.random() < mistakeChance(skill)) {
    const valid = [];
    for (let c = 0; c < C4_COLS; c++) if (_c4DropRow(board, c) >= 0) valid.push(c);
    if (valid.length === 0) return { fallback: true };
    return { action: { type: 'drop', col: valid[Math.floor(Math.random() * valid.length)] } };
  }

  const validCols = [3, 2, 4, 1, 5, 0, 6].filter(c => _c4DropRow(board, c) >= 0);
  if (validCols.length === 0) return { fallback: true };

  // Time-budgeted iterative deepening: search depth 1, 2, 3, … keeping the best
  // move from the last FULLY-completed depth. This makes the house as deep as
  // it can be (skill 5 routinely reaches depth 9-11) while guaranteeing it never
  // blocks the single-threaded server for more than ~the budget on any one move.
  const maxDepth = skill >= 5 ? 16 : Math.max(2, skill + 1);
  const deadline = Date.now() + (skill >= 5 ? 600 : 250);
  let bestCol = validCols[0];
  for (let d = Math.max(2, Math.min(4, maxDepth)); d <= maxDepth; d++) {
    try {
      const result = _c4Minimax(board, me, me, opp, d, -Infinity, Infinity, deadline);
      if (result.move !== null && result.move !== undefined) bestCol = result.move;
      // Found a forced result (win/loss proven) — no need to search deeper.
      if (result.score >= 90000 || result.score <= -90000) break;
    } catch (e) {
      if (e === C4_TIMEOUT) break; // keep best move from the last completed depth
      throw e;
    }
  }
  return { action: { type: 'drop', col: bestCol } };
}

// ──────────────────────────────────────────────────────────────
// NIM — optimal play uses XOR (Sprague-Grundy)
// ──────────────────────────────────────────────────────────────

// MISÈRE Nim — taking the last stone LOSES. Strategy:
//   - If 2+ piles have size >= 2: play normal-Nim XOR-to-zero
//   - If 0-1 piles have size >= 2: leave opponent an ODD number of 1-piles
//
// This is the proven optimal strategy for misère Nim.
function nimMove(game, idx, agent) {
  const piles = Array.isArray(game.piles) ? game.piles.slice() : null;
  if (!piles || piles.length === 0) return { fallback: true };
  const skill = (agent && agent.skill) || 3;

  const nonEmptyIdxs = piles.map((v, i) => v > 0 ? i : -1).filter(i => i >= 0);
  if (nonEmptyIdxs.length === 0) return { fallback: true };

  function randomMove() {
    const pi = nonEmptyIdxs[Math.floor(Math.random() * nonEmptyIdxs.length)];
    const take = 1 + Math.floor(Math.random() * Math.min(piles[pi], 3));
    return { action: { type: 'take', pile: pi, count: take } };
  }

  // Low skill: mostly random
  if (skill <= 2) return randomMove();
  // Even high skill blunders some of the time
  if (Math.random() < mistakeChance(skill)) return randomMove();

  const bigPiles = piles.map((v, i) => v >= 2 ? i : -1).filter(i => i >= 0);
  const onePiles = piles.filter(v => v === 1).length;

  // Endgame: 0 or 1 "big" piles -> misère adjustment.
  if (bigPiles.length === 0) {
    // All remaining piles are 1. Take 1 from any 1-pile (forced).
    return { action: { type: 'take', pile: nonEmptyIdxs[0], count: 1 } };
  }
  if (bigPiles.length === 1) {
    // One big pile + some 1-piles. Reduce big pile so total 1-piles is ODD.
    //   - If onePiles is even, leave big as 1  (ones+1 = odd)
    //   - If onePiles is odd,  leave big as 0  (ones stays odd)
    const bp = bigPiles[0];
    const target = (onePiles % 2 === 0) ? 1 : 0;
    const take = piles[bp] - target;
    if (take > 0) return { action: { type: 'take', pile: bp, count: take } };
  }

  // Normal Nim: leave XOR-sum at 0
  let xor = 0;
  for (const p of piles) xor ^= p;
  if (xor !== 0) {
    for (let i = 0; i < piles.length; i++) {
      const target = piles[i] ^ xor;
      if (target < piles[i]) {
        return { action: { type: 'take', pile: i, count: piles[i] - target } };
      }
    }
  }
  // Already in a losing position — take 1 from the largest pile.
  let bestPile = nonEmptyIdxs[0];
  for (const i of nonEmptyIdxs) if (piles[i] > piles[bestPile]) bestPile = i;
  return { action: { type: 'take', pile: bestPile, count: 1 } };
}

// ──────────────────────────────────────────────────────────────
// REVERSI / OTHELLO — corner priority + greedy flip count
// ──────────────────────────────────────────────────────────────
//
// Reversi has a famous heuristic: corners > X-squares (cells diagonal to
// corners are bad to play early), edges > middle. We add a small weight
// for mobility (number of moves we leave) and flip count.

const REVERSI_WEIGHTS = [
  [120,-20, 20,  5,  5, 20,-20,120],
  [-20,-40, -5, -5, -5, -5,-40,-20],
  [ 20, -5, 15,  3,  3, 15, -5, 20],
  [  5, -5,  3,  3,  3,  3, -5,  5],
  [  5, -5,  3,  3,  3,  3, -5,  5],
  [ 20, -5, 15,  3,  3, 15, -5, 20],
  [-20,-40, -5, -5, -5, -5,-40,-20],
  [120,-20, 20,  5,  5, 20,-20,120],
];

// Self-contained Reversi simulation (so we can do real lookahead without
// mutating the live game object). Board is a 8x8 array of null|0|1.
const _REV_DIRS = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

function _revFlips(board, row, col, player) {
  if (board[row][col] !== null) return [];
  const opp = 1 - player;
  const all = [];
  for (const [dr, dc] of _REV_DIRS) {
    const line = [];
    let r = row + dr, c = col + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === opp) { line.push([r, c]); r += dr; c += dc; }
    if (line.length > 0 && r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === player) all.push(...line);
  }
  return all;
}

function _revValidMoves(board, player) {
  const moves = [];
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (board[r][c] === null && _revFlips(board, r, c, player).length > 0) moves.push({ row: r, col: c });
  return moves;
}

function _revApply(board, row, col, player) {
  const nb = board.map(r => r.slice());
  const flips = _revFlips(nb, row, col, player);
  nb[row][col] = player;
  for (const [fr, fc] of flips) nb[fr][fc] = player;
  return nb;
}

function _revCounts(board) {
  let c0 = 0, c1 = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (board[r][c] === 0) c0++; else if (board[r][c] === 1) c1++;
  }
  return [c0, c1];
}

function _revEval(board, me) {
  const opp = 1 - me;
  let positional = 0, my = 0, op = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const v = board[r][c];
    if (v === null) continue;
    if (v === me) { positional += REVERSI_WEIGHTS[r][c]; my++; }
    else { positional -= REVERSI_WEIGHTS[r][c]; op++; }
  }
  const empties = 64 - my - op;
  if (empties <= 8) {
    // Endgame: discs are what actually win — weight raw count heavily.
    return (my - op) * 100 + positional;
  }
  // Mid-game: positional control + mobility (having more moves than opponent
  // is the heart of strong Othello play). Disc count barely matters yet.
  const myMob = _revValidMoves(board, me).length;
  const opMob = _revValidMoves(board, opp).length;
  return positional + (myMob - opMob) * 8;
}

const REV_TIMEOUT = { timeout: true };
function _revMinimax(board, current, me, depth, alpha, beta, deadline) {
  if (deadline && Date.now() > deadline) throw REV_TIMEOUT;
  if (depth === 0) return _revEval(board, me);
  const moves = _revValidMoves(board, current);
  if (moves.length === 0) {
    // No move: pass. If opponent also can't move, the game is over → final count.
    if (_revValidMoves(board, 1 - current).length === 0) {
      const [c0, c1] = _revCounts(board);
      const diff = (me === 0 ? c0 - c1 : c1 - c0);
      return diff > 0 ? 100000 + diff : diff < 0 ? -100000 + diff : 0;
    }
    return _revMinimax(board, 1 - current, me, depth - 1, alpha, beta, deadline);
  }
  const isMax = current === me;
  let best = isMax ? -Infinity : Infinity;
  for (const m of moves) {
    const nb = _revApply(board, m.row, m.col, current);
    const score = _revMinimax(nb, 1 - current, me, depth - 1, alpha, beta, deadline);
    if (isMax) { if (score > best) best = score; if (best > alpha) alpha = best; }
    else       { if (score < best) best = score; if (best < beta)  beta  = best; }
    if (alpha >= beta) break;
  }
  return best;
}

function reversiMove(game, idx, agent) {
  if (!Array.isArray(game.board)) return { fallback: true };
  const board = game.board;
  const moves = _revValidMoves(board, idx);
  if (moves.length === 0) return { fallback: true };
  const skill = (agent && agent.skill) || 3;

  // Low skill plays loosely; skill 5 (vs-house) never does.
  if (skill <= 2 && Math.random() < 0.5) {
    const pick = moves[Math.floor(Math.random() * moves.length)];
    return { action: { type: 'place', row: pick.row, col: pick.col } };
  }
  if (Math.random() < mistakeChance(skill)) {
    const pick = moves[Math.floor(Math.random() * moves.length)];
    return { action: { type: 'place', row: pick.row, col: pick.col } };
  }

  // Time-budgeted iterative deepening. Target depth grows toward an exact
  // endgame solve (≤10 empties → solve to the end for perfect disc count),
  // but a wall-clock deadline guarantees we never block the shared server.
  const empties = 64 - _revCounts(board).reduce((a, b) => a + b, 0);
  const maxDepth = empties <= 13 ? empties : Math.min(9, Math.max(3, skill + 4));
  const deadline = Date.now() + (skill >= 5 ? 600 : 300);

  let best = moves[0];
  for (let d = 2; d <= maxDepth; d++) {
    let localBest = null, localScore = -Infinity, alpha = -Infinity, aborted = false;
    for (const m of moves) {
      let score;
      try {
        score = _revMinimax(_revApply(board, m.row, m.col, idx), 1 - idx, idx, d - 1, alpha, Infinity, deadline);
      } catch (e) {
        if (e === REV_TIMEOUT) { aborted = true; break; }
        throw e;
      }
      if (score > localScore) { localScore = score; localBest = m; }
      if (localScore > alpha) alpha = localScore;
    }
    if (aborted) break;            // keep best from last completed depth
    if (localBest) best = localBest;
    if (localScore >= 100000) break; // proven win
  }
  return { action: { type: 'place', row: best.row, col: best.col } };
}

// ──────────────────────────────────────────────────────────────
// MEMORY — track revealed cards; skill controls memory fidelity
// ──────────────────────────────────────────────────────────────

function memoryMove(game, idx, agent) {
  if (!Array.isArray(game.cards) || !Array.isArray(game.matched)) return { fallback: true };
  const total = game.cards.length;
  const skill = (agent && agent.skill) || 3;

  // Build the bot's memory map: symbol -> [card indices it has seen].
  // We update it from currently-revealed cards each turn.
  if (!game._botMemory) game._botMemory = {};
  for (let i = 0; i < total; i++) {
    if (game.matched[i] || game.revealed[i]) {
      const sym = game.cards[i];
      if (!game._botMemory[sym]) game._botMemory[sym] = new Set();
      game._botMemory[sym].add(i);
    }
  }

  // Memory fidelity: skill 5 = 100% recall, skill 1 = ~40% recall.
  // We simulate "forgetting" by randomly dropping entries per call.
  const recallChance = 0.4 + 0.15 * skill;
  const usableMemory = {};
  for (const sym of Object.keys(game._botMemory)) {
    for (const i of game._botMemory[sym]) {
      if (game.matched[i] || game.flipped.includes(i)) continue;
      if (Math.random() < recallChance) {
        if (!usableMemory[sym]) usableMemory[sym] = [];
        usableMemory[sym].push(i);
      }
    }
  }

  const available = [];
  for (let i = 0; i < total; i++) {
    if (!game.matched[i] && !game.flipped.includes(i)) available.push(i);
  }
  if (available.length === 0) return { fallback: true };

  if (game.flipped.length === 0) {
    // First flip of the turn. If I remember a matching pair, flip one of them.
    for (const sym of Object.keys(usableMemory)) {
      if (usableMemory[sym].length >= 2) {
        return { action: { type: 'flip', index: usableMemory[sym][0] } };
      }
    }
    // Otherwise: flip an unknown card to learn (lower skill picks more randomly)
    const unknown = available.filter(i => !game.revealed[i]);
    const pool = unknown.length > 0 ? unknown : available;
    return { action: { type: 'flip', index: pool[Math.floor(Math.random() * pool.length)] } };
  } else {
    // Second flip — try to match the first revealed card.
    const firstIdx = game.flipped[0];
    const firstSym = game.cards[firstIdx];
    if (usableMemory[firstSym]) {
      for (const idx2 of usableMemory[firstSym]) {
        if (idx2 !== firstIdx && available.includes(idx2)) {
          return { action: { type: 'flip', index: idx2 } };
        }
      }
    }
    // No match remembered: flip an unknown card
    const unknown = available.filter(i => !game.revealed[i]);
    const pool = unknown.length > 0 ? unknown : available;
    return { action: { type: 'flip', index: pool[Math.floor(Math.random() * pool.length)] } };
  }
}

// ──────────────────────────────────────────────────────────────
// BATTLESHIP — hunt mode (parity sweep) + target mode (after hits)
// ──────────────────────────────────────────────────────────────

const BS_SIZE = 10;

function _bsHits(game, idx) {
  // Cells where idx fired AND hit a ship on the opponent's board.
  const opp = 1 - idx;
  const hits = [];
  for (let r = 0; r < BS_SIZE; r++) {
    for (let c = 0; c < BS_SIZE; c++) {
      if (game.shots[idx][r][c] && game.boards[opp][r][c] !== null) {
        hits.push({ r, c, shipId: game.boards[opp][r][c] });
      }
    }
  }
  return hits;
}

function _bsUnshot(game, idx) {
  const out = [];
  for (let r = 0; r < BS_SIZE; r++)
    for (let c = 0; c < BS_SIZE; c++)
      if (!game.shots[idx][r][c]) out.push({ r, c });
  return out;
}

// Known state of each cell on the opponent's board, from what the bot has
// legitimately learned by firing (NOT by peeking at hidden ships):
//   'miss'    — fired, empty water
//   'hit'     — fired, hit a ship that is NOT yet sunk
//   'sunk'    — part of a fully-sunk ship (its cells are revealed to anyone)
//   'unknown' — never fired here
function _bsState(game, idx) {
  const opp = 1 - idx;
  const st = Array.from({ length: BS_SIZE }, () => Array(BS_SIZE).fill('unknown'));
  for (let r = 0; r < BS_SIZE; r++) {
    for (let c = 0; c < BS_SIZE; c++) {
      if (!game.shots[idx][r][c]) continue;
      const v = game.boards[opp][r][c];
      if (v === null) { st[r][c] = 'miss'; continue; }
      const ship = game.ships[opp][v];
      st[r][c] = (ship && ship.sunk) ? 'sunk' : 'hit';
    }
  }
  return st;
}

// Battleship probability-density targeting — the strongest standard approach.
// For every remaining (unsunk) ship, count all the ways it could still be
// placed given known misses/sinks, accumulating a "heat" score per cell.
// When there are open hits, only count placements that cover them (and weight
// by how many), which makes the bot extend along a wounded ship optimally.
function battleshipMove(game, idx, agent) {
  if (!game.shots || !game.boards || !game.ships) return { fallback: true };
  const skill = (agent && agent.skill) || 3;
  const opp = 1 - idx;

  // Skill-based blunder (skill 5 — vs-house — never fires blindly).
  if (Math.random() < mistakeChance(skill)) {
    const all = _bsUnshot(game, idx);
    if (all.length === 0) return { fallback: true };
    const pick = all[Math.floor(Math.random() * all.length)];
    return { action: { type: 'fire', row: pick.r, col: pick.c } };
  }

  const st = _bsState(game, idx);
  const remaining = game.ships[opp].filter(s => !s.sunk).map(s => s.size);
  if (remaining.length === 0) {
    const all = _bsUnshot(game, idx);
    if (all.length === 0) return { fallback: true };
    const pick = all[Math.floor(Math.random() * all.length)];
    return { action: { type: 'fire', row: pick.r, col: pick.c } };
  }

  const openHits = [];
  for (let r = 0; r < BS_SIZE; r++)
    for (let c = 0; c < BS_SIZE; c++)
      if (st[r][c] === 'hit') openHits.push([r, c]);

  const prob = Array.from({ length: BS_SIZE }, () => Array(BS_SIZE).fill(0));
  const accumulate = (cells) => {
    // A placement is only possible if it avoids misses and sunk cells.
    let hitsCovered = 0;
    for (const [r, c] of cells) {
      const s = st[r][c];
      if (s === 'miss' || s === 'sunk') return;
      if (s === 'hit') hitsCovered++;
    }
    // In target mode (open hits exist) only consider placements that touch a
    // hit, and weight strongly by how many hits they line up with.
    let weight;
    if (openHits.length > 0) {
      if (hitsCovered === 0) return;
      weight = Math.pow(50, hitsCovered);
    } else {
      weight = 1;
    }
    for (const [r, c] of cells) {
      if (st[r][c] === 'unknown') prob[r][c] += weight;
    }
  };

  for (const L of remaining) {
    for (let r = 0; r < BS_SIZE; r++) {
      for (let c = 0; c + L <= BS_SIZE; c++) {
        const cells = [];
        for (let i = 0; i < L; i++) cells.push([r, c + i]);
        accumulate(cells);
      }
    }
    for (let c = 0; c < BS_SIZE; c++) {
      for (let r = 0; r + L <= BS_SIZE; r++) {
        const cells = [];
        for (let i = 0; i < L; i++) cells.push([r + i, c]);
        accumulate(cells);
      }
    }
  }

  // Fire at the highest-probability unknown cell (random tie-break).
  let bestVal = -1;
  let bestCells = [];
  for (let r = 0; r < BS_SIZE; r++) {
    for (let c = 0; c < BS_SIZE; c++) {
      if (st[r][c] !== 'unknown') continue;
      if (prob[r][c] > bestVal) { bestVal = prob[r][c]; bestCells = [[r, c]]; }
      else if (prob[r][c] === bestVal) bestCells.push([r, c]);
    }
  }

  if (bestVal > 0 && bestCells.length > 0) {
    const [r, c] = bestCells[Math.floor(Math.random() * bestCells.length)];
    return { action: { type: 'fire', row: r, col: c } };
  }

  // Fallback (no placement scored — e.g. degenerate state): adjacent to a hit,
  // else any remaining cell.
  if (openHits.length > 0) {
    const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
    for (const [hr, hc] of openHits) {
      for (const [dr, dc] of dirs) {
        const nr = hr + dr, nc = hc + dc;
        if (nr >= 0 && nr < BS_SIZE && nc >= 0 && nc < BS_SIZE && st[nr][nc] === 'unknown') {
          return { action: { type: 'fire', row: nr, col: nc } };
        }
      }
    }
  }
  const all = _bsUnshot(game, idx);
  if (all.length === 0) return { fallback: true };
  const pick = all[Math.floor(Math.random() * all.length)];
  return { action: { type: 'fire', row: pick.r, col: pick.c } };
}

// ──────────────────────────────────────────────────────────────
// MANCALA — extra-turn / capture detection + 1-ply lookahead
// ──────────────────────────────────────────────────────────────

function _mancalaApply(pits, playerIndex, pitIndex) {
  // Returns { newPits, extraTurn, captured }
  const p = pits.slice();
  const seeds = p[pitIndex];
  if (seeds === 0) return null;
  p[pitIndex] = 0;
  const oppStore = playerIndex === 0 ? 13 : 6;
  let pos = pitIndex;
  for (let i = 0; i < seeds; i++) {
    pos = (pos + 1) % 14;
    if (pos === oppStore) pos = (pos + 1) % 14;
    p[pos]++;
  }
  const myStore = playerIndex === 0 ? 6 : 13;
  const extraTurn = pos === myStore;
  let captured = 0;
  if (!extraTurn) {
    const [lo, hi] = playerIndex === 0 ? [0, 5] : [7, 12];
    if (pos >= lo && pos <= hi && p[pos] === 1) {
      const opposite = 12 - pos;
      if (p[opposite] > 0) {
        captured = p[opposite] + 1;
        p[myStore] += captured;
        p[opposite] = 0;
        p[pos] = 0;
      }
    }
  }
  return { newPits: p, extraTurn, captured };
}

function _mancalaScore(pits, playerIndex) {
  // Heuristic: my store - opp store + (some weight) * seeds-on-my-side
  const myStore = playerIndex === 0 ? 6 : 13;
  const oppStore = playerIndex === 0 ? 13 : 6;
  const [mlo, mhi] = playerIndex === 0 ? [0, 5] : [7, 12];
  let mySide = 0;
  for (let i = mlo; i <= mhi; i++) mySide += pits[i];
  return (pits[myStore] - pits[oppStore]) * 4 + mySide * 0.5;
}

function _mancalaSideEmpty(pits, player) {
  const [lo, hi] = player === 0 ? [0, 5] : [7, 12];
  for (let i = lo; i <= hi; i++) if (pits[i] > 0) return false;
  return true;
}

// Final score from `me`'s perspective once a side empties: sweep the remaining
// seeds into each owner's store (matches MancalaGame._collectRemaining) and
// return the store difference. Large magnitude so wins dominate the search.
function _mancalaFinal(pits, me) {
  const p = pits.slice();
  for (const [lo, hi, store] of [[0, 5, 6], [7, 12, 13]]) {
    for (let i = lo; i <= hi; i++) { p[store] += p[i]; p[i] = 0; }
  }
  const diff = me === 0 ? p[6] - p[13] : p[13] - p[6];
  return diff >= 0 ? 100000 + diff : -100000 + diff;
}

function _mancalaLegal(pits, player) {
  const [lo, hi] = player === 0 ? [0, 5] : [7, 12];
  const out = [];
  for (let i = lo; i <= hi; i++) if (pits[i] > 0) out.push(i);
  return out;
}

const MANCALA_TIMEOUT = { timeout: true };
function _mancalaMinimax(pits, current, me, depth, alpha, beta, deadline) {
  if (deadline && Date.now() > deadline) throw MANCALA_TIMEOUT;
  if (_mancalaSideEmpty(pits, 0) || _mancalaSideEmpty(pits, 1)) return _mancalaFinal(pits, me);
  if (depth === 0) return _mancalaScore(pits, me);
  const legal = _mancalaLegal(pits, current);
  if (legal.length === 0) return _mancalaFinal(pits, me);

  const isMax = current === me;
  let best = isMax ? -Infinity : Infinity;
  for (const pit of legal) {
    const r = _mancalaApply(pits, current, pit);
    if (!r) continue;
    // Extra turn → same player moves again (no turn flip).
    const next = r.extraTurn ? current : 1 - current;
    const score = _mancalaMinimax(r.newPits, next, me, depth - 1, alpha, beta, deadline);
    if (isMax) { if (score > best) best = score; if (best > alpha) alpha = best; }
    else       { if (score < best) best = score; if (best < beta)  beta  = best; }
    if (alpha >= beta) break;
  }
  return best;
}

function mancalaMove(game, idx, agent) {
  if (!Array.isArray(game.pits)) return { fallback: true };
  const pits = game.pits;
  const skill = (agent && agent.skill) || 3;

  const legalPits = _mancalaLegal(pits, idx);
  if (legalPits.length === 0) return { fallback: true };

  if (skill <= 2 || Math.random() < mistakeChance(skill)) {
    const pick = legalPits[Math.floor(Math.random() * legalPits.length)];
    return { action: { type: 'sow', pit: pick } };
  }

  // Iterative-deepening minimax with extra-turn chains. Branching is ≤6 so we
  // search very deep cheaply; skill 5 targets 13 plies (near-perfect Kalah)
  // under a wall-clock deadline that keeps the server responsive.
  const maxDepth = skill >= 5 ? 13 : Math.max(3, skill + 2);
  const deadline = Date.now() + (skill >= 5 ? 450 : 200);
  let best = legalPits[0];
  for (let d = Math.min(5, maxDepth); d <= maxDepth; d++) {
    let localBest = null, localScore = -Infinity, alpha = -Infinity, aborted = false;
    for (const pit of legalPits) {
      const r = _mancalaApply(pits, idx, pit);
      if (!r) continue;
      const next = r.extraTurn ? idx : 1 - idx;
      let score;
      try {
        score = _mancalaMinimax(r.newPits, next, idx, d - 1, alpha, Infinity, deadline);
      } catch (e) {
        if (e === MANCALA_TIMEOUT) { aborted = true; break; }
        throw e;
      }
      if (score > localScore) { localScore = score; localBest = pit; }
      if (localScore > alpha) alpha = localScore;
    }
    if (aborted) break;             // keep best from last completed depth
    if (localBest !== null) best = localBest;
    if (localScore >= 100000) break; // proven win
  }
  return { action: { type: 'sow', pit: best } };
}

// ──────────────────────────────────────────────────────────────
// DOTS & BOXES — claim boxes; avoid giving 3rd side; smallest sacrifice
// ──────────────────────────────────────────────────────────────

function _dbCountSides(hLines, vLines, r, c) {
  let n = 0;
  if (hLines[r][c]     !== null) n++;
  if (hLines[r + 1][c] !== null) n++;
  if (vLines[r][c]     !== null) n++;
  if (vLines[r][c + 1] !== null) n++;
  return n;
}

function _dbSimulateLine(game, line) {
  // Returns { boxesMade, newHLines, newVLines }
  const newH = game.hLines.map(row => row.slice());
  const newV = game.vLines.map(row => row.slice());
  if (line.orientation === 'h') newH[line.row][line.col] = 'sim';
  else newV[line.row][line.col] = 'sim';
  let boxesMade = 0;
  for (let r = 0; r < game.rows; r++) {
    for (let c = 0; c < game.cols; c++) {
      if (game.boxes[r][c] === null) {
        if (newH[r][c] !== null && newH[r+1][c] !== null && newV[r][c] !== null && newV[r][c+1] !== null) {
          boxesMade++;
        }
      }
    }
  }
  return { boxesMade, newH, newV };
}

function _dbAllLines(game) {
  const out = [];
  for (let r = 0; r <= game.rows; r++)
    for (let c = 0; c < game.cols; c++)
      if (game.hLines[r][c] === null) out.push({ orientation: 'h', row: r, col: c });
  for (let r = 0; r < game.rows; r++)
    for (let c = 0; c <= game.cols; c++)
      if (game.vLines[r][c] === null) out.push({ orientation: 'v', row: r, col: c });
  return out;
}

// ── Self-contained Dots & Boxes solver (for the decisive endgame). ──
// State carries line grids + box ownership so we can search to the very end
// and discover the "double-cross" (declining the last 2 boxes of a chain to
// keep control) — the single most important winning technique in the game,
// which the old greedy heuristic never did.
function _dbFreeLines(h, v, rows, cols) {
  const out = [];
  for (let r = 0; r <= rows; r++) for (let c = 0; c < cols; c++) if (h[r][c] === null) out.push({ o: 'h', r, c });
  for (let r = 0; r < rows; r++) for (let c = 0; c <= cols; c++) if (v[r][c] === null) out.push({ o: 'v', r, c });
  return out;
}
function _dbBoxComplete(h, v, r, c) {
  return h[r][c] !== null && h[r + 1][c] !== null && v[r][c] !== null && v[r][c + 1] !== null;
}
function _dbStep(h, v, boxes, rows, cols, line, current) {
  // Returns { h, v, boxes, made } after drawing `line` for `current`.
  const nh = h.map(x => x.slice());
  const nv = v.map(x => x.slice());
  const nb = boxes.map(x => x.slice());
  if (line.o === 'h') nh[line.r][line.c] = current; else nv[line.r][line.c] = current;
  let made = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (nb[r][c] === null && _dbBoxComplete(nh, nv, r, c)) { nb[r][c] = current; made++; }
  }
  return { h: nh, v: nv, boxes: nb, made };
}
function _dbSolve(h, v, boxes, current, me, rows, cols, alpha, beta, budget) {
  if (++budget.n > budget.max) budget.over = true;
  else if ((budget.n & 1023) === 0 && budget.deadline && Date.now() > budget.deadline) budget.over = true;
  const free = _dbFreeLines(h, v, rows, cols);
  if (free.length === 0 || budget.over) {
    let m = 0, o = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (boxes[r][c] === me) m++; else if (boxes[r][c] === 1 - me) o++;
    }
    return m - o;
  }
  // Move ordering: try capturing moves first (better pruning). Compute each
  // line's step ONCE (the old comparator re-simulated per comparison).
  const stepped = free.map(ln => ({ ln, s: _dbStep(h, v, boxes, rows, cols, ln, current) }));
  stepped.sort((a, b) => b.s.made - a.s.made);
  const isMax = current === me;
  let best = isMax ? -Infinity : Infinity;
  for (const { s } of stepped) {
    const next = s.made > 0 ? current : 1 - current; // completing a box → go again
    const val = _dbSolve(s.h, s.v, s.boxes, next, me, rows, cols, alpha, beta, budget);
    if (isMax) { if (val > best) best = val; if (best > alpha) alpha = best; }
    else       { if (val < best) best = val; if (best < beta) beta = best; }
    if (alpha >= beta || budget.over) break;
  }
  return best;
}
function _dbExactBestMove(game, me) {
  const { rows, cols } = game;
  const h = game.hLines.map(x => x.slice());
  const v = game.vLines.map(x => x.slice());
  const boxes = game.boxes.map(x => x.slice());
  const free = _dbFreeLines(h, v, rows, cols);
  const budget = { n: 0, max: 300000, over: false, deadline: Date.now() + 500 };
  let best = null, bestVal = -Infinity, alpha = -Infinity;
  for (const ln of free) {
    const s = _dbStep(h, v, boxes, rows, cols, ln, me);
    const next = s.made > 0 ? me : 1 - me;
    const val = _dbSolve(s.h, s.v, s.boxes, next, me, rows, cols, alpha, Infinity, budget);
    if (val > bestVal) { bestVal = val; best = ln; }
    if (bestVal > alpha) alpha = bestVal;
    if (budget.over) break;
  }
  if (budget.over) return null; // search too big — defer to heuristic
  return best;
}

function dotsboxesMove(game, idx, agent) {
  if (!Array.isArray(game.hLines) || !Array.isArray(game.vLines)) return { fallback: true };
  const skill = (agent && agent.skill) || 3;
  const lines = _dbAllLines(game);
  if (lines.length === 0) return { fallback: true };

  // Blunder rate
  if (Math.random() < mistakeChance(skill)) {
    const pick = lines[Math.floor(Math.random() * lines.length)];
    return { action: { type: 'line', orientation: pick.orientation, row: pick.row, col: pick.col } };
  }

  // Endgame: once few lines remain, solve EXACTLY (with chain control /
  // double-cross). This is where Dots & Boxes is actually won or lost.
  if (skill >= 4 && lines.length <= 16) {
    const exact = _dbExactBestMove(game, idx);
    if (exact) return { action: { type: 'line', orientation: exact.o, row: exact.r, col: exact.c } };
  }

  // 1) Take any move that completes a box.
  const completing = [];
  for (const ln of lines) {
    const sim = _dbSimulateLine(game, ln);
    if (sim.boxesMade > 0) completing.push({ ln, boxes: sim.boxesMade });
  }
  if (completing.length > 0) {
    completing.sort((a, b) => b.boxes - a.boxes);
    const best = completing[0].ln;
    return { action: { type: 'line', orientation: best.orientation, row: best.row, col: best.col } };
  }

  // 2) Among non-completing moves, prefer "safe" ones — those that don't
  // give opponent a 3-sided box (i.e. don't push any box from 2->3 sides).
  const safe = [];
  const unsafe = [];
  for (const ln of lines) {
    const sim = _dbSimulateLine(game, ln);
    let createsThreat = false;
    for (let r = 0; r < game.rows; r++) {
      for (let c = 0; c < game.cols; c++) {
        if (game.boxes[r][c] !== null) continue;
        let n = 0;
        if (sim.newH[r][c] !== null) n++;
        if (sim.newH[r+1][c] !== null) n++;
        if (sim.newV[r][c] !== null) n++;
        if (sim.newV[r][c+1] !== null) n++;
        if (n === 3) { createsThreat = true; break; }
      }
      if (createsThreat) break;
    }
    if (createsThreat) unsafe.push(ln);
    else safe.push(ln);
  }

  if (safe.length > 0) {
    const pick = safe[Math.floor(Math.random() * safe.length)];
    return { action: { type: 'line', orientation: pick.orientation, row: pick.row, col: pick.col } };
  }

  // 3) Forced into giving boxes — pick the move that gives the SHORTEST chain
  // (approximated by counting how many 3-sided boxes the move creates;
  // opponent will only get to claim that many in their next turn unless they
  // can chain). Simple heuristic: prefer move that creates fewest 3-side boxes.
  let bestPick = unsafe[0];
  let bestThreats = Infinity;
  for (const ln of unsafe) {
    const sim = _dbSimulateLine(game, ln);
    let threats = 0;
    for (let r = 0; r < game.rows; r++) {
      for (let c = 0; c < game.cols; c++) {
        if (game.boxes[r][c] !== null) continue;
        let n = 0;
        if (sim.newH[r][c] !== null) n++;
        if (sim.newH[r+1][c] !== null) n++;
        if (sim.newV[r][c] !== null) n++;
        if (sim.newV[r][c+1] !== null) n++;
        if (n === 3) threats++;
      }
    }
    if (threats < bestThreats) { bestThreats = threats; bestPick = ln; }
  }
  return { action: { type: 'line', orientation: bestPick.orientation, row: bestPick.row, col: bestPick.col } };
}

// ──────────────────────────────────────────────────────────────
// HEX — shortest connection-path heuristic (Dijkstra-like)
// ──────────────────────────────────────────────────────────────
//
// Player 0 connects left edge (col 0) to right edge (col SIZE-1).
// Player 1 connects top edge (row 0) to bottom edge (row SIZE-1).
// For each empty cell, compute: cost to connect my edges through it
// (1 per empty cell on the path, 0 per my own stone, infinity per opponent).
// Pick the cell that maximally reduces my path AND increases opponent's.

function _hexNeighbors(r, c, size) {
  const dirs = [[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0]];
  const out = [];
  for (const [dr, dc] of dirs) {
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size) out.push([nr, nc]);
  }
  return out;
}

function _hexShortestPath(board, size, player) {
  // BFS-like Dijkstra with binary weights (0 if my stone, 1 if empty, blocked if opp).
  // For player 0: source = all cells in col 0 not blocked by opp; target = col size-1.
  // For player 1: source = all cells in row 0; target = row size-1.
  const dist = Array.from({ length: size }, () => Array(size).fill(Infinity));
  // Use a simple 0-1 BFS with two-ended queue
  const deque = [];
  if (player === 0) {
    for (let r = 0; r < size; r++) {
      if (board[r][0] === null) { dist[r][0] = 1; deque.push([r, 0]); }
      else if (board[r][0] === player) { dist[r][0] = 0; deque.unshift([r, 0]); }
    }
  } else {
    for (let c = 0; c < size; c++) {
      if (board[0][c] === null) { dist[0][c] = 1; deque.push([0, c]); }
      else if (board[0][c] === player) { dist[0][c] = 0; deque.unshift([0, c]); }
    }
  }
  while (deque.length > 0) {
    const [r, c] = deque.shift();
    for (const [nr, nc] of _hexNeighbors(r, c, size)) {
      const cell = board[nr][nc];
      if (cell !== null && cell !== player) continue;
      const w = cell === player ? 0 : 1;
      if (dist[r][c] + w < dist[nr][nc]) {
        dist[nr][nc] = dist[r][c] + w;
        if (w === 0) deque.unshift([nr, nc]);
        else deque.push([nr, nc]);
      }
    }
  }
  let minDist = Infinity;
  if (player === 0) {
    for (let r = 0; r < size; r++) if (dist[r][size - 1] < minDist) minDist = dist[r][size - 1];
  } else {
    for (let c = 0; c < size; c++) if (dist[size - 1][c] < minDist) minDist = dist[size - 1][c];
  }
  return minDist;
}

function hexMove(game, idx, agent) {
  if (!Array.isArray(game.board)) return { fallback: true };
  const board = game.board;
  const size = game.board.length;
  const opp = 1 - idx;
  const skill = (agent && agent.skill) || 3;

  const empties = [];
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (board[r][c] === null) empties.push({ row: r, col: c });
  if (empties.length === 0) return { fallback: true };

  if (skill <= 2 || Math.random() < mistakeChance(skill)) {
    // Prefer the center area
    empties.sort((a, b) => Math.abs(a.row - size/2) + Math.abs(a.col - size/2) -
                            (Math.abs(b.row - size/2) + Math.abs(b.col - size/2)));
    const pool = empties.slice(0, Math.max(1, Math.floor(empties.length / 3)));
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return { action: { type: 'place', row: pick.row, col: pick.col } };
  }

  // For each empty cell, simulate placing my stone there and compute
  // my shortest connection path vs the opponent's. Pick the cell that most
  // reduces my path while lengthening theirs.
  //
  // The board is small (7x7), so at skill 5 we evaluate EVERY empty cell
  // (the old 25-cell cap discarded good edge/bridge moves and cost games).
  // Lower skills keep the cheaper center-biased sample.
  let best = empties[0];
  let bestScore = Infinity;
  const sampled = (skill >= 5 || empties.length <= 25) ? empties :
    empties.sort((a, b) => Math.abs(a.row - size/2) + Math.abs(a.col - size/2) -
                            (Math.abs(b.row - size/2) + Math.abs(b.col - size/2))).slice(0, 25);

  const mid = (size - 1) / 2;
  const eval1 = (m) => {
    board[m.row][m.col] = idx;
    const myDist = _hexShortestPath(board, size, idx);
    const oppDist = _hexShortestPath(board, size, opp);
    board[m.row][m.col] = null;
    // Lower is better. Weight my offense slightly more, and add a small
    // centrality bias so strong central/bridge moves beat weak edge moves on
    // ties (central play dominates in Hex).
    const centrality = (Math.abs(m.row - mid) + Math.abs(m.col - mid)) * 0.06;
    return myDist - oppDist * 0.85 + centrality;
  };

  const scored = sampled.map(m => ({ m, s: eval1(m) }));
  scored.sort((a, b) => a.s - b.s);

  // Skill 5: verify the top candidates 2-ply deep — place my stone, let the
  // opponent make THEIR best reply (same metric from their side), and keep the
  // move with the best worst-case. Catches the classic Hex trap where a
  // 1-ply-greedy move can be neutralized by a single strong block.
  if (skill >= 5 && scored.length > 1) {
    const deadline = Date.now() + 350;
    const myTop = scored.slice(0, 10);
    let bestM = myTop[0].m;
    let bestVal = Infinity;
    for (const cand of myTop) {
      if (Date.now() > deadline) break;
      board[cand.m.row][cand.m.col] = idx;
      // Opponent's best reply (their lowest score from their perspective).
      let oppBest = Infinity;
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (board[r][c] !== null) continue;
          board[r][c] = opp;
          const oDist = _hexShortestPath(board, size, opp);
          const mDist = _hexShortestPath(board, size, idx);
          board[r][c] = null;
          const oScore = oDist - mDist * 0.85; // lower = better for them
          if (oScore < oppBest) oppBest = oScore;
        }
      }
      board[cand.m.row][cand.m.col] = null;
      // My value after their best reply: higher oppBest (worse for them) is better for me.
      const val = cand.s - oppBest * 0.9;
      if (val < bestVal) { bestVal = val; bestM = cand.m; }
    }
    return { action: { type: 'place', row: bestM.row, col: bestM.col } };
  }

  for (const { m, s } of scored) {
    if (s < bestScore) { bestScore = s; best = m; }
  }
  return { action: { type: 'place', row: best.row, col: best.col } };
}

// ──────────────────────────────────────────────────────────────
// CHECKERS — minimax depth 3-5 with material + king bonus
// ──────────────────────────────────────────────────────────────

// `forcedFrom` controls multi-jump continuation state:
//   undefined → root call: honor the live game.mustJumpFrom
//   null      → simulated node with no pending jump: ignore the (stale) live state
//   number    → simulated node mid multi-jump: only that piece may continue jumping
function _checkersAllMoves(game, player, forcedFrom) {
  const moves = [];
  if (typeof forcedFrom === 'number') {
    const piece = game.board[forcedFrom];
    if (piece && piece.player === player) {
      const jumps = game._getJumps(forcedFrom, piece);
      for (const j of jumps) moves.push({ from: forcedFrom, to: j.to });
    }
    return moves;
  }
  if (forcedFrom === undefined && game.mustJumpFrom !== null) {
    const piece = game.board[game.mustJumpFrom];
    if (piece && piece.player === player) {
      const jumps = game._getJumps(game.mustJumpFrom, piece);
      for (const j of jumps) moves.push({ from: game.mustJumpFrom, to: j.to });
    }
    return moves;
  }
  const hasJumps = game._playerHasJumps(player);
  for (let i = 0; i < 64; i++) {
    const p = game.board[i];
    if (!p || p.player !== player) continue;
    if (hasJumps) {
      const js = game._getJumps(i, p);
      for (const j of js) moves.push({ from: i, to: j.to });
    } else {
      const ms = game._getMoves(i, p);
      for (const t of ms) moves.push({ from: i, to: t });
    }
  }
  return moves;
}

function _checkersEval(game, me) {
  let myScore = 0, oppScore = 0;
  let myPieces = 0, oppPieces = 0;
  for (let i = 0; i < 64; i++) {
    const p = game.board[i];
    if (!p) continue;
    const r = Math.floor(i / 8), c = i % 8;
    // A king is worth far more than a man.
    const val = p.king ? 5.5 : 3;
    // Advancement toward promotion (men only — kings move both ways).
    const advance = p.king ? 0 : (p.player === 0 ? (7 - r) : r) * 0.12;
    // Central files are stronger than the edges.
    const center = (3.5 - Math.abs(c - 3.5)) * 0.08;
    // Back-row defense: keeping the home rank stops the opponent promoting.
    const backRow = (!p.king && ((p.player === 0 && r === 7) || (p.player === 1 && r === 0))) ? 0.4 : 0;
    const contrib = val + advance + center + backRow;
    if (p.player === me) { myScore += contrib; myPieces++; }
    else { oppScore += contrib; oppPieces++; }
  }
  // Mobility: more available moves is a real positional edge in checkers.
  // (pass null: simulated positions must ignore the live game's mustJumpFrom)
  const myMob = _checkersAllMoves(game, me, null).length;
  const oppMob = _checkersAllMoves(game, 1 - me, null).length;
  // When ahead in material, encourage trading down (fewer pieces on board).
  const tradeBonus = (myPieces - oppPieces) > 0 ? (24 - myPieces - oppPieces) * 0.05 * (myPieces - oppPieces) : 0;
  return (myScore - oppScore) + (myMob - oppMob) * 0.08 + tradeBonus;
}

const CHECKERS_TIMEOUT = { timeout: true };
function _checkersMinimax(game, current, me, depth, alpha, beta, deadline, forcedFrom) {
  if (deadline && Date.now() > deadline) throw CHECKERS_TIMEOUT;
  if (game.gameOver) {
    if (game.winner === me) return 1000;
    if (game.winner === null) return 0;
    return -1000;
  }
  if (depth === 0) return _checkersEval(game, me);

  const moves = _checkersAllMoves(game, current, forcedFrom === undefined ? null : forcedFrom);
  if (moves.length === 0) return current === me ? -1000 : 1000;

  const isMax = (current === me);
  let best = isMax ? -Infinity : Infinity;
  for (const m of moves) {
    // Simulate
    const piece = game.board[m.from];
    const captured = [];
    // Detect jump: distance > 1 square
    const fr = Math.floor(m.from / 8), fc = m.from % 8;
    const tr = Math.floor(m.to / 8),   tc = m.to % 8;
    const isJump = Math.abs(tr - fr) === 2;
    const midPos = isJump ? ((fr + tr) / 2) * 8 + ((fc + tc) / 2) : null;
    if (isJump) { captured.push({ pos: midPos, piece: game.board[midPos] }); game.board[midPos] = null; }
    game.board[m.to] = piece;
    game.board[m.from] = null;
    const wasKing = piece.king;
    if (!piece.king) {
      if ((piece.player === 0 && tr === 0) || (piece.player === 1 && tr === 7)) piece.king = true;
    }

    const continuing = isJump && game._getJumps(m.to, piece).length > 0;
    const nextPlayer = continuing ? current : 1 - current;
    // Mid multi-jump only the jumping piece may move again — restrict the
    // child node accordingly (the old code let ANY piece move, which made the
    // search misjudge forced capture chains).
    let score;
    try {
      score = _checkersMinimax(game, nextPlayer, me, depth - 1, alpha, beta, deadline, continuing ? m.to : null);
    } finally {
      // Undo in `finally`: this search mutates the LIVE game board, and the
      // deadline timeout propagates as an exception. Without the finally, a
      // timeout would skip the undo in every parent frame and permanently
      // corrupt the real game state.
      game.board[m.from] = piece;
      game.board[m.to] = null;
      if (!wasKing) piece.king = false;
      for (const cap of captured) game.board[cap.pos] = cap.piece;
    }

    if (isMax) { if (score > best) best = score; alpha = Math.max(alpha, best); }
    else       { if (score < best) best = score; beta  = Math.min(beta,  best); }
    if (alpha >= beta) break;
  }
  return best;
}

function checkersMove(game, idx, agent) {
  if (!Array.isArray(game.board) || typeof game._getJumps !== 'function') return { fallback: true };
  const skill = (agent && agent.skill) || 3;
  const moves = _checkersAllMoves(game, idx);
  if (moves.length === 0) return { fallback: true };

  // Low skill: random move (still must take forced jump if any)
  if (skill <= 2 || Math.random() < mistakeChance(skill)) {
    const pick = moves[Math.floor(Math.random() * moves.length)];
    return { action: { type: 'move', from: pick.from, to: pick.to } };
  }

  // Iterative deepening under a wall-clock budget. Skill 5 targets depth 11
  // (the old fixed depth 6 finished in <100ms — huge headroom was unused);
  // lower skills keep the shallower fixed target.
  const maxDepth = skill >= 5 ? 11 : Math.max(2, skill + 1);
  const deadline = Date.now() + (skill >= 5 ? 500 : 200);

  function scoreMoveAtDepth(m, depth) {
    // Simulate one ply, recurse with remaining depth
    const piece = game.board[m.from];
    const fr = Math.floor(m.from / 8), fc = m.from % 8;
    const tr = Math.floor(m.to / 8),   tc = m.to % 8;
    const isJump = Math.abs(tr - fr) === 2;
    const captured = [];
    const midPos = isJump ? ((fr + tr) / 2) * 8 + ((fc + tc) / 2) : null;
    if (isJump) { captured.push({ pos: midPos, piece: game.board[midPos] }); game.board[midPos] = null; }
    game.board[m.to] = piece;
    game.board[m.from] = null;
    const wasKing = piece.king;
    if (!piece.king && ((piece.player === 0 && tr === 0) || (piece.player === 1 && tr === 7))) piece.king = true;
    const continuing = isJump && game._getJumps(m.to, piece).length > 0;
    const nextPlayer = continuing ? idx : 1 - idx;
    let score, err = null;
    try {
      score = _checkersMinimax(game, nextPlayer, idx, depth - 1, -Infinity, Infinity, deadline, continuing ? m.to : null);
    } catch (e) { err = e; }
    game.board[m.from] = piece;
    game.board[m.to] = null;
    if (!wasKing) piece.king = false;
    for (const cap of captured) game.board[cap.pos] = cap.piece;
    if (err) throw err;
    return score;
  }

  let bestMove = moves[0];
  for (let d = Math.min(4, maxDepth); d <= maxDepth; d++) {
    let localBest = null, localScore = -Infinity, aborted = false;
    for (const m of moves) {
      let score;
      try { score = scoreMoveAtDepth(m, d); }
      catch (e) {
        if (e === CHECKERS_TIMEOUT) { aborted = true; break; }
        throw e;
      }
      if (score > localScore) { localScore = score; localBest = m; }
    }
    if (aborted) break;          // keep best from last completed depth
    if (localBest) bestMove = localBest;
    if (localScore >= 1000) break; // proven win
  }
  return { action: { type: 'move', from: bestMove.from, to: bestMove.to } };
}

// ──────────────────────────────────────────────────────────────
// CHESS — greedy capture + don't-blunder + center preference
// ──────────────────────────────────────────────────────────────
//
// Full chess minimax is too risky to implement correctly without extensive
// testing. Instead: avoid hanging pieces, take any free piece, prefer
// development. Far better than picking the first legal move.

const PIECE_VAL = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 20000 };

function _chessAllMoves(game, player) {
  const out = [];
  for (let i = 0; i < 64; i++) {
    const p = game.board[i];
    if (p && p.player === player) {
      const tos = game._getLegalMoves(i);
      for (const to of tos) out.push({ from: i, to });
    }
  }
  return out;
}

function chessMove(game, idx, agent) {
  if (!Array.isArray(game.board) || typeof game._getLegalMoves !== 'function') return { fallback: true };
  const skill = (agent && agent.skill) || 3;
  const opp = 1 - idx;
  const moves = _chessAllMoves(game, idx);
  if (moves.length === 0) return { fallback: true };

  if (skill <= 2 || Math.random() < mistakeChance(skill)) {
    const pick = moves[Math.floor(Math.random() * moves.length)];
    return { action: { type: 'move', from: pick.from, to: pick.to } };
  }

  // Score each move with shallow lookahead: my move minus opp's best reply.
  function pieceVal(p) { return p ? PIECE_VAL[p.type] : 0; }

  let bestMove = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const captured = game.board[m.to];
    const captureGain = pieceVal(captured);
    // Tentatively make the move
    const moving = game.board[m.from];
    game.board[m.to] = moving;
    game.board[m.from] = null;

    // What is the most valuable piece opponent can capture in response?
    let oppBest = 0;
    try {
      const oppMoves = _chessAllMoves(game, opp);
      for (const om of oppMoves) {
        const t = game.board[om.to];
        if (t && t.player === idx) {
          const v = PIECE_VAL[t.type];
          if (v > oppBest) oppBest = v;
        }
      }
    } catch (_) { /* keep going */ }

    // Restore
    game.board[m.from] = moving;
    game.board[m.to] = captured;

    // Heuristic bonus for central squares & development in opening
    const tr = Math.floor(m.to / 8), tc = m.to % 8;
    const centerBonus = (3.5 - Math.abs(tr - 3.5) - Math.abs(tc - 3.5)) * 2; // 7 best, 0 worst
    const score = captureGain - oppBest * 0.85 + centerBonus * 0.5;

    if (score > bestScore) { bestScore = score; bestMove = m; }
  }
  return { action: { type: 'move', from: bestMove.from, to: bestMove.to } };
}

// ──────────────────────────────────────────────────────────────
// BACKGAMMON — pip count + blot avoidance
// ──────────────────────────────────────────────────────────────

function backgammonMove(game, idx, agent) {
  // The game expects:
  //   - { type: 'roll' } if !diceRolled
  //   - { type: 'move', from, to, die } per move within turn
  if (!game.diceRolled) {
    return { action: { type: 'roll' } };
  }
  if (typeof game._getValidMoves !== 'function') return { fallback: true };
  const moves = game._getValidMoves(idx);
  if (!moves || moves.length === 0) return { fallback: true };
  const skill = (agent && agent.skill) || 3;

  if (skill <= 2 || Math.random() < mistakeChance(skill)) {
    const pick = moves[Math.floor(Math.random() * moves.length)];
    return { action: { type: 'move', from: pick.from, to: pick.to, die: pick.die } };
  }

  // Score each candidate by pip-count delta + blot penalty.
  // We don't know the game's internal point structure precisely, so this is
  // a coarse heuristic: pip distance from start to bear-off direction.
  const isP0 = idx === 0;
  const direction = isP0 ? -1 : 1;
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    // Pip gain = distance moved in our direction
    const pipGain = Math.abs(m.to - m.from);
    // Tiny blot bonus: prefer 'to' that ISN'T a single point (we don't know,
    // so just prefer moves that go further in our direction)
    const score = pipGain * direction * direction + (Math.random() * 0.5);
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return { action: { type: 'move', from: best.from, to: best.to, die: best.die } };
}

// ──────────────────────────────────────────────────────────────
// SPEED — real-time card play; scan hand for any playable card
// ──────────────────────────────────────────────────────────────

function _speedIsAdjacent(v1, v2) {
  const diff = Math.abs(v1 - v2);
  return diff === 1 || diff === 12; // A wraps with K
}

function speedMove(game, idx, agent) {
  if (!game.hands || !game.piles || !game.hands[idx]) return { fallback: true };
  const hand = game.hands[idx];
  const piles = game.piles;
  if (!piles[0] || !piles[1]) return { fallback: true };

  // Scan hand for any playable card. Skill 5 finds it instantly; lower skill
  // may "miss" a few times (simulated via mistakeChance below).
  const skill = (agent && agent.skill) || 3;
  if (Math.random() < mistakeChance(skill)) return null; // "wait" for a beat

  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (_speedIsAdjacent(c.value, piles[0].value)) {
      return { action: { type: 'play', handIndex: i, pileIndex: 0 } };
    }
    if (_speedIsAdjacent(c.value, piles[1].value)) {
      return { action: { type: 'play', handIndex: i, pileIndex: 1 } };
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────
// DOMINO — play highest-pip playable tile (reduce hand value)
// ──────────────────────────────────────────────────────────────

function dominoMove(game, idx, agent) {
  if (!game.hands || !game.hands[idx]) return { fallback: true };
  const hand = game.hands[idx];
  const skill = (agent && agent.skill) || 3;

  if (Math.random() < mistakeChance(skill)) {
    return { fallback: true }; // defer to game's autoPlay (random-ish)
  }

  if (hand.length === 0) return { fallback: true };

  // Opening move (empty board): play highest double, else highest pip tile.
  if (game.board.length === 0) {
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < hand.length; i++) {
      const t = hand[i];
      const isDouble = t[0] === t[1];
      const score = (t[0] + t[1]) + (isDouble ? 100 : 0);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    return { action: { type: 'play', tileIndex: bestIdx, side: 'right' } };
  }

  // Find all playable tiles and pick highest pip count first (to deplete hand value)
  const candidates = [];
  for (let i = 0; i < hand.length; i++) {
    const t = hand[i];
    const matchL = t[0] === game.boardLeft || t[1] === game.boardLeft;
    const matchR = t[0] === game.boardRight || t[1] === game.boardRight;
    if (matchL) candidates.push({ idx: i, side: 'left',  pip: t[0] + t[1] });
    if (matchR) candidates.push({ idx: i, side: 'right', pip: t[0] + t[1] });
  }

  if (candidates.length === 0) {
    if (game.boneyard.length > 0) return { action: { type: 'auto_draw' } };
    return { action: { type: 'pass' } };
  }

  candidates.sort((a, b) => b.pip - a.pip);
  const best = candidates[0];
  return { action: { type: 'play', tileIndex: best.idx, side: best.side } };
}

// ──────────────────────────────────────────────────────────────
// SPEED — find any playable card immediately. Bot delay handled in agents.js.
// ──────────────────────────────────────────────────────────────
//
// Speed is real-time: whoever clears their hand first wins. The old
// auto-play just stalled, which meant the human always won by burning
// through their own hand. Now the bot actively plays every tick.

function speedMove(game, idx, agent) {
  if (!Array.isArray(game.hands) || !Array.isArray(game.piles)) return { fallback: true };
  const hand = game.hands[idx];
  if (!hand || hand.length === 0) return { fallback: true };
  const piles = game.piles;
  if (!piles[0] || !piles[1]) return { fallback: true };

  // Find any playable (card, pile). Prefer the one that leaves us with a
  // hand whose minimum next-play value is smaller (greedy clearing).
  let best = null;
  for (let h = 0; h < hand.length; h++) {
    const c = hand[h];
    if (!c) continue;
    for (let p = 0; p < 2; p++) {
      const pileCard = piles[p];
      const diff = Math.abs(c.value - pileCard.value);
      if (diff === 1 || diff === 12) {
        // Prefer to play cards that are "edges" of our hand (max or min value)
        // so we don't get stuck with hand cards that can't chain. Tiny heuristic.
        const score = -Math.min(c.value, 14 - c.value); // edge-preference
        if (!best || score > best.score) {
          best = { handIndex: h, pileIndex: p, score };
        }
      }
    }
  }
  if (!best) return { fallback: true };
  return { action: { type: 'play', handIndex: best.handIndex, pileIndex: best.pileIndex } };
}

// ──────────────────────────────────────────────────────────────
// DOMINO — dump highest-pip tiles; prefer ends opponent likely can't match
// ──────────────────────────────────────────────────────────────
//
// Domino scoring rewards the player whose opponent gets stuck with high
// pips. We track which end-values the opponent has REFUSED to play on
// (forced draw or pass) — those are dead values they don't have. Prefer
// playing tiles that expose those dead values, choking the opponent.

function _domTilePips(t) { return t[0] + t[1]; }

function dominoMove(game, idx, agent) {
  if (game.roundOver || game.gameOver) return { fallback: true };
  if (!Array.isArray(game.hands)) return { fallback: true };
  const hand = game.hands[idx];
  if (!hand || hand.length === 0) return { fallback: true };

  // Opening: board is empty — play the highest-pip tile we own
  // (with double preference: a [6,6] double is the canonical opener).
  if (game.board.length === 0) {
    let bestI = 0, bestScore = -Infinity;
    for (let i = 0; i < hand.length; i++) {
      const t = hand[i];
      let score = t[0] + t[1];
      if (t[0] === t[1]) score += 3; // doubles bonus
      if (score > bestScore) { bestScore = score; bestI = i; }
    }
    return { action: { type: 'play', tileIndex: bestI, side: 'right' } };
  }

  const left = game.boardLeft, right = game.boardRight;
  const playable = [];
  for (let i = 0; i < hand.length; i++) {
    const t = hand[i];
    if (t[0] === right || t[1] === right) playable.push({ i, side: 'right', t });
    else if (t[0] === left || t[1] === left) playable.push({ i, side: 'left', t });
  }

  if (playable.length === 0) {
    if (game.boneyard && game.boneyard.length > 0) return { action: { type: 'auto_draw' } };
    return { action: { type: 'pass' } };
  }

  // Compute, for each candidate move, the resulting "exposed pip" on the
  // played side after we play. Prefer ends that match VALUES we have
  // duplicates of (so we can keep playing) AND values the opponent has
  // likely shown they don't have (passed on previously).
  //
  // Opponent's known-missing values: tracked via game.consecutivePasses
  // history — coarse but better than nothing.
  let bestMove = playable[0];
  let bestScore = -Infinity;
  for (const m of playable) {
    const t = m.t;
    const pip = _domTilePips(t);
    // After playing, the new exposed value at this end is the OTHER pip
    // (the pip that doesn't match the current board end).
    const newExposed = m.side === 'right'
      ? (t[0] === right ? t[1] : t[0])
      : (t[0] === left ? t[1] : t[0]);
    // Bonus if we hold MORE tiles matching newExposed (chain potential)
    let chainPotential = 0;
    for (let j = 0; j < hand.length; j++) {
      if (j === m.i) continue;
      if (hand[j][0] === newExposed || hand[j][1] === newExposed) chainPotential++;
    }
    // Doubles: prefer playing them when we still have the opportunity
    const doublesBonus = (t[0] === t[1]) ? 4 : 0;
    const score = pip * 1.5 + chainPotential * 3 + doublesBonus;
    if (score > bestScore) { bestScore = score; bestMove = m; }
  }
  return { action: { type: 'play', tileIndex: bestMove.i, side: bestMove.side } };
}

// ──────────────────────────────────────────────────────────────
// Dispatch
// ──────────────────────────────────────────────────────────────

function strategyMove(gameType, game, idx, agent) {
  try {
    switch (gameType) {
      case 'morpion':    return morpionMove(game, idx, agent);
      case 'tictactoe':  return tttMove(game, idx, agent);
      case 'connect4':   return c4Move(game, idx, agent);
      case 'nim':        return nimMove(game, idx, agent);
      case 'reversi':    return reversiMove(game, idx, agent);
      case 'memory':     return memoryMove(game, idx, agent);
      case 'battleship': return battleshipMove(game, idx, agent);
      case 'mancala':    return mancalaMove(game, idx, agent);
      case 'dotsboxes':  return dotsboxesMove(game, idx, agent);
      case 'hex':        return hexMove(game, idx, agent);
      case 'checkers':   return checkersMove(game, idx, agent);
      case 'chess':      return chessMove(game, idx, agent);
      case 'backgammon': return backgammonMove(game, idx, agent);
      case 'speed':      return speedMove(game, idx, agent);
      case 'domino':     return dominoMove(game, idx, agent);
      default:           return { fallback: true };
    }
  } catch (e) {
    console.warn('houseStrategy error for', gameType, '-', e.message);
    return { fallback: true };
  }
}

module.exports = { strategyMove };
