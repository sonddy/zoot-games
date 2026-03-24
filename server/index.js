require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const {
  Keypair, Connection, PublicKey, LAMPORTS_PER_SOL,
  Transaction, SystemProgram, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const DominoGame = require('./games/domino');
const TicTacToeGame = require('./games/tictactoe');
const MancalaGame = require('./games/mancala');
const CheckersGame = require('./games/checkers');
const ChessGame = require('./games/chess');
const MorpionGame = require('./games/morpion');
const WarGame = require('./games/war');
const SpeedGame = require('./games/speed');
const PokerGame = require('./games/poker');
const ReversiGame = require('./games/reversi');
const Connect4Game = require('./games/connect4');
const BattleshipGame = require('./games/battleship');
const BackgammonGame = require('./games/backgammon');
const RPSGame = require('./games/rps');
const CoinFlipGame = require('./games/coinflip');
const DiceDuelGame = require('./games/diceduel');
const HiLoGame = require('./games/hilo');
const DotsBoxesGame = require('./games/dotsboxes');
const NimGame = require('./games/nim');
const HexGame = require('./games/hex');
const ReactionGame = require('./games/reaction');
const MemoryGame = require('./games/memory');
const MathDuelGame = require('./games/mathduel');

const SOLANA_RPC = process.env.SOLANA_RPC || 'https://solana-rpc.publicnode.com';
const solanaConnection = new Connection(SOLANA_RPC, 'confirmed');

let escrowKeypair;
if (process.env.ESCROW_PRIVATE_KEY) {
  escrowKeypair = Keypair.fromSecretKey(Buffer.from(process.env.ESCROW_PRIVATE_KEY, 'base64'));
} else {
  escrowKeypair = Keypair.generate();
  console.log('WARNING: No ESCROW_PRIVATE_KEY set. Generated temporary escrow wallet:');
  console.log('  Address:', escrowKeypair.publicKey.toBase58());
  console.log('  Private key (base64):', Buffer.from(escrowKeypair.secretKey).toString('base64'));
  console.log('  Set ESCROW_PRIVATE_KEY env var to persist this wallet across restarts!');
}
const ESCROW_ADDRESS = escrowKeypair.publicKey.toBase58();
console.log('Escrow wallet:', ESCROW_ADDRESS);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/escrow', (req, res) => {
  res.json({ escrowAddress: ESCROW_ADDRESS });
});

app.get('/api/sports/:sport/:league/scoreboard', async (req, res) => {
  const { sport, league } = req.params;
  const allowed = ['soccer','football','basketball','baseball','hockey','mma'];
  if (!allowed.includes(sport)) return res.status(400).json({ error: 'Invalid sport' });
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard`;
    const resp = await fetch(url);
    if (!resp.ok) return res.status(resp.status).json({ error: 'ESPN API error' });
    const data = await resp.json();
    res.set('Cache-Control', 'public, max-age=20');
    res.json(data);
  } catch (err) {
    console.error('ESPN proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch from ESPN' });
  }
});

const rooms = new Map();
const players = new Map();
const matchQueue = new Map();
const usedSignatures = new Set();
const sportsBets = new Map();

const HOUSE_FEE = 0.10;
const HOUSE_WALLET = '2LK7yxZsy6YVCkFQ4PrL644ve1fgRj5FuDexj5JgS753';
const TEST_MODE = process.env.TEST_MODE === '1';

async function sendSOL(toAddress, amount) {
  const destPubKey = new PublicKey(toAddress);
  const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: escrowKeypair.publicKey,
      toPubkey: destPubKey,
      lamports,
    })
  );
  const sig = await sendAndConfirmTransaction(solanaConnection, tx, [escrowKeypair]);
  console.log(`Sent ${amount} SOL to ${toAddress} — tx: ${sig}`);
  return sig;
}

async function verifyBetPayment(signature, expectedAmount) {
  if (usedSignatures.has(signature)) return { ok: false, error: 'Transaction already used' };

  const tx = await solanaConnection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || tx.meta.err) return { ok: false, error: 'Transaction not found or failed' };

  const accountKeys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
  const escrowIndex = accountKeys.findIndex(k => k.toBase58() === ESCROW_ADDRESS);
  if (escrowIndex === -1) return { ok: false, error: 'Transaction does not pay the escrow' };

  const received = (tx.meta.postBalances[escrowIndex] - tx.meta.preBalances[escrowIndex]) / LAMPORTS_PER_SOL;
  if (received < expectedAmount * 0.99) return { ok: false, error: 'Insufficient payment. Received ' + received.toFixed(6) + ' SOL' };

  usedSignatures.add(signature);
  return { ok: true, received };
}

function createRoom(gameType, betAmount, player1Socket) {
  const id = uuidv4().slice(0, 8);
  const room = { id, gameType, betAmount, players: [player1Socket], state: 'waiting', game: null, createdAt: Date.now(), turnTimer: null };
  rooms.set(id, room);
  return room;
}

async function handleGameOver(room, result) {
  clearTurnTimer(room);
  room.state = 'finished';
  const winnerIdx = result.winner;
  const pot = room.betAmount * 2;
  const houseCut = pot * HOUSE_FEE;
  const payout = pot - houseCut;

  if (winnerIdx !== null) {
    const winnerSocketId = room.players[winnerIdx];
    const winnerPlayer = players.get(winnerSocketId);
    if (winnerPlayer && !TEST_MODE) {
      try {
        await sendSOL(winnerPlayer.walletAddress, payout);
        const winSock = io.sockets.sockets.get(winnerSocketId);
        if (winSock) winSock.emit('balance_update', { refreshWallet: true, msg: 'You won ' + payout.toFixed(3) + ' SOL!' });
      } catch (e) {
        console.error('Payout error:', e.message);
      }
      try {
        await sendSOL(HOUSE_WALLET, houseCut);
        console.log('House fee sent:', houseCut.toFixed(4), 'SOL to', HOUSE_WALLET);
      } catch (e) {
        console.error('House fee transfer error:', e.message);
      }
    }
    io.to(room.id).emit('game_over', {
      winner: winnerPlayer ? winnerPlayer.displayName : null,
      winnerWallet: winnerPlayer ? winnerPlayer.walletAddress : null,
      payout, isDraw: false, resigned: !!result.resigned,
    });
  } else {
    if (!TEST_MODE) {
      for (const sid of room.players) {
        const p = players.get(sid);
        if (p) {
          try {
            await sendSOL(p.walletAddress, room.betAmount);
            const s = io.sockets.sockets.get(sid);
            if (s) s.emit('balance_update', { refreshWallet: true, msg: 'Draw — bet refunded!' });
          } catch (e) {
            console.error('Refund error:', e.message);
          }
        }
      }
    }
    io.to(room.id).emit('game_over', { winner: null, winnerWallet: null, payout: 0, isDraw: true });
  }
  setTimeout(() => cleanupRoom(room.id), 5000);
}

const TIMER_DELAYS = { domino: 15500, mancala: 20500, checkers: 30500, chess: 60500, morpion: 30500, war: 15500, speed: 20500, poker: 30500, reversi: 30500, connect4: 20500, battleship: 25500, backgammon: 30500, rps: 10500, coinflip: 10500, diceduel: 10500, hilo: 15500, dotsboxes: 20500, nim: 20500, hex: 30500, reaction: 15500, memory: 20500, mathduel: 15500 };

function startTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.game || room.game.gameOver) return;
  if (room.game.roundOver) return;
  const delay = TIMER_DELAYS[room.gameType];
  if (!delay) return;

  room.turnTimer = setTimeout(() => {
    if (!room.game || room.game.gameOver || room.state !== 'playing') return;
    if (room.game.roundOver) return;
    const cp = room.game.currentPlayer;
    const result = room.game.autoPlayForTimeout(cp);
    if (!result) return;
    emitGameState(room);

    if (result.gameOver) {
      handleGameOver(room, result);
    } else {
      startTurnTimer(room);
    }
  }, delay);
}

function clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on('register', async ({ walletAddress, displayName }) => {
    if (!walletAddress || walletAddress.length < 2) return socket.emit('error_msg', { msg: 'Invalid wallet address' });
    if (!TEST_MODE) {
      try { new PublicKey(walletAddress); } catch (_) { return socket.emit('error_msg', { msg: 'Invalid Solana address' }); }
    }

    players.set(socket.id, { walletAddress, displayName: displayName || walletAddress.slice(0, 6), roomId: null });

    socket.emit('registered', {
      success: true,
      walletAddress,
      displayName: displayName || walletAddress.slice(0, 6),
      escrowAddress: ESCROW_ADDRESS,
      testMode: TEST_MODE,
    });
    broadcastLobby();
  });

  socket.on('find_match', async ({ gameType, betAmount, gridSize, txSignature }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const bet = parseFloat(betAmount) || 0;
    if (!TEST_MODE) {
      if (!bet || bet <= 0) return socket.emit('error_msg', { msg: 'Invalid bet amount' });
      if (!txSignature) return socket.emit('error_msg', { msg: 'No payment transaction provided' });
      const verification = await verifyBetPayment(txSignature, bet);
      if (!verification.ok) return socket.emit('error_msg', { msg: verification.error });
    }

    const opts = {};
    if (gameType === 'tictactoe' && gridSize) opts.gridSize = gridSize;

    const queueKey = `${gameType}_${bet}${gridSize ? '_' + gridSize : ''}`;
    if (matchQueue.has(queueKey)) {
      const waiting = matchQueue.get(queueKey);
      matchQueue.delete(queueKey);

      const room = createRoom(gameType, bet, waiting.socketId);
      room.options = { ...waiting.options, ...opts };
      room.players.push(socket.id);
      room.state = 'playing';

      players.get(waiting.socketId).roomId = room.id;
      player.roomId = room.id;

      const sock1 = io.sockets.sockets.get(waiting.socketId);
      if (sock1) sock1.join(room.id);
      socket.join(room.id);

      startGame(room);
    } else {
      matchQueue.set(queueKey, { socketId: socket.id, bet, txSignature, options: opts });
      socket.emit('waiting', { msg: 'Waiting for an opponent...', betAmount: bet, gameType });
    }
    broadcastLobby();
  });

  socket.on('cancel_search', async () => {
    for (const [key, val] of matchQueue) {
      if (val.socketId === socket.id) {
        const player = players.get(socket.id);
        if (player && !TEST_MODE) {
          try {
            await sendSOL(player.walletAddress, val.bet);
            socket.emit('balance_update', { refreshWallet: true, msg: 'Bet refunded to your wallet!' });
          } catch (e) {
            console.error('Refund error:', e.message);
            socket.emit('error_msg', { msg: 'Refund failed: ' + e.message });
          }
        }
        matchQueue.delete(key);
        break;
      }
    }
    socket.emit('search_cancelled');
    broadcastLobby();
  });

  socket.on('accept_bet', async ({ betId, txSignature }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const entry = matchQueue.get(betId);
    if (!entry) return socket.emit('error_msg', { msg: 'This bet is no longer available' });

    if (entry.socketId === socket.id) return socket.emit('error_msg', { msg: 'You cannot accept your own bet' });

    const bet = entry.bet;

    if (!TEST_MODE) {
      if (!txSignature) return socket.emit('error_msg', { msg: 'No payment transaction provided' });
      const verification = await verifyBetPayment(txSignature, bet);
      if (!verification.ok) return socket.emit('error_msg', { msg: verification.error });
    }

    if (!matchQueue.has(betId)) return socket.emit('error_msg', { msg: 'Bet was taken by someone else' });
    matchQueue.delete(betId);

    const parts = betId.split('_');
    const gameType = parts[0];
    const opts = entry.options || {};

    const room = createRoom(gameType, bet, entry.socketId);
    room.options = opts;
    room.players.push(socket.id);
    room.state = 'playing';

    const waitingPlayer = players.get(entry.socketId);
    if (waitingPlayer) waitingPlayer.roomId = room.id;
    player.roomId = room.id;

    const sock1 = io.sockets.sockets.get(entry.socketId);
    if (sock1) sock1.join(room.id);
    socket.join(room.id);

    startGame(room);
    broadcastLobby();
  });

  socket.on('game_action', async (action) => {
    const player = players.get(socket.id);
    if (!player || !player.roomId) return;
    const room = rooms.get(player.roomId);
    if (!room || !room.game) return;

    const playerIndex = room.players.indexOf(socket.id);
    const result = room.game.handleAction(playerIndex, action);
    if (result.error) return socket.emit('error_msg', { msg: result.error });

    emitGameState(room);

    if (result.gameOver) {
      await handleGameOver(room, result);
    } else if (result.newRound || !result.roundOver) {
      startTurnTimer(room);
    }
  });

  socket.on('create_sports_bet', async ({ eventId, matchName, league, sportKey, pick, teamName, betAmount, txSignature }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const bet = parseFloat(betAmount) || 0;
    if (!TEST_MODE) {
      if (!bet || bet <= 0) return socket.emit('error_msg', { msg: 'Invalid bet amount' });
      if (!txSignature) return socket.emit('error_msg', { msg: 'No payment transaction provided' });
      const verification = await verifyBetPayment(txSignature, bet);
      if (!verification.ok) return socket.emit('error_msg', { msg: verification.error });
    }

    const betId = 'sb_' + uuidv4().slice(0, 8);
    sportsBets.set(betId, {
      id: betId,
      eventId,
      matchName: matchName || 'Unknown Match',
      league: league || '',
      sportKey: sportKey || '',
      pick,
      teamName: teamName || pick,
      betAmount: bet,
      creatorSocketId: socket.id,
      creatorWallet: player.walletAddress,
      creatorName: player.displayName,
      txSignature,
      createdAt: Date.now(),
      status: 'open',
    });

    socket.emit('sports_bet_created', { betId, betAmount: bet });
    broadcastLobby();
  });

  socket.on('accept_sports_bet', async ({ betId, txSignature }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const entry = sportsBets.get(betId);
    if (!entry) return socket.emit('error_msg', { msg: 'This sports bet is no longer available' });
    if (entry.status !== 'open') return socket.emit('error_msg', { msg: 'This bet has already been taken' });
    if (entry.creatorSocketId === socket.id) return socket.emit('error_msg', { msg: 'You cannot accept your own bet' });

    const bet = entry.betAmount;
    if (!TEST_MODE) {
      if (!txSignature) return socket.emit('error_msg', { msg: 'No payment transaction provided' });
      const verification = await verifyBetPayment(txSignature, bet);
      if (!verification.ok) return socket.emit('error_msg', { msg: verification.error });
    }

    entry.status = 'matched';
    entry.acceptorSocketId = socket.id;
    entry.acceptorWallet = player.walletAddress;
    entry.acceptorName = player.displayName;
    entry.acceptTxSignature = txSignature;
    entry.acceptorPick = entry.pick === 'home' ? 'away' : (entry.pick === 'away' ? 'home' : 'not-draw');
    entry.matchedAt = Date.now();

    const pot = bet * 2;
    const houseCut = pot * HOUSE_FEE;
    const payout = pot - houseCut;

    const creatorSock = io.sockets.sockets.get(entry.creatorSocketId);
    if (creatorSock) creatorSock.emit('sports_bet_matched', { betId, acceptorName: entry.acceptorName, payout });

    socket.emit('sports_bet_accepted', { betId, matchName: entry.matchName, payout });
    broadcastLobby();
  });

  socket.on('cancel_sports_bet', async ({ betId }) => {
    const player = players.get(socket.id);
    if (!player) return;

    const entry = sportsBets.get(betId);
    if (!entry || entry.creatorSocketId !== socket.id || entry.status !== 'open') return;

    if (!TEST_MODE) {
      try {
        await sendSOL(player.walletAddress, entry.betAmount);
        socket.emit('balance_update', { refreshWallet: true, msg: 'Sports bet refunded!' });
      } catch (e) {
        console.error('Sports bet refund error:', e.message);
        socket.emit('error_msg', { msg: 'Refund failed: ' + e.message });
      }
    }

    sportsBets.delete(betId);
    broadcastLobby();
  });

  socket.on('get_lobby', () => broadcastLobby());

  socket.on('disconnect', async () => {
    console.log(`Disconnected: ${socket.id}`);
    const player = players.get(socket.id);

    for (const [key, val] of matchQueue) {
      if (val.socketId === socket.id) {
        if (player && !TEST_MODE) {
          try { await sendSOL(player.walletAddress, val.bet); } catch (e) { console.error('Refund on disconnect:', e.message); }
        }
        matchQueue.delete(key);
        break;
      }
    }

    if (player && player.roomId) {
      const room = rooms.get(player.roomId);
      if (room && room.state === 'playing') {
        const remainingIdx = room.players.indexOf(socket.id) === 0 ? 1 : 0;
        const winnerSocketId = room.players[remainingIdx];
        const winnerPlayer = players.get(winnerSocketId);

        const pot = room.betAmount * 2;
        const houseCut = pot * HOUSE_FEE;
        const payout = pot - houseCut;

        if (winnerPlayer && !TEST_MODE) {
          try {
            await sendSOL(winnerPlayer.walletAddress, payout);
            const winSock = io.sockets.sockets.get(winnerSocketId);
            if (winSock) winSock.emit('balance_update', { refreshWallet: true, msg: 'Opponent left — you won ' + payout.toFixed(3) + ' SOL!' });
          } catch (e) { console.error('Payout on disconnect:', e.message); }
          try {
            await sendSOL(HOUSE_WALLET, houseCut);
            console.log('House fee sent:', houseCut.toFixed(4), 'SOL to', HOUSE_WALLET);
          } catch (e) { console.error('House fee on disconnect:', e.message); }
        }

        io.to(room.id).emit('game_over', {
          winner: winnerPlayer ? winnerPlayer.displayName : null,
          winnerWallet: winnerPlayer ? winnerPlayer.walletAddress : null,
          payout, isDraw: false, reason: 'Opponent disconnected',
        });
        room.state = 'finished';
        setTimeout(() => cleanupRoom(room.id), 3000);
      }
    }

    for (const [sbId, sb] of sportsBets) {
      if (sb.creatorSocketId === socket.id && sb.status === 'open') {
        if (player && !TEST_MODE) {
          try { await sendSOL(player.walletAddress, sb.betAmount); } catch (e) { console.error('Sports bet refund on disconnect:', e.message); }
        }
        sportsBets.delete(sbId);
      }
    }

    players.delete(socket.id);
    broadcastLobby();
  });
});

function startGame(room) {
  if (room.gameType === 'domino') room.game = new DominoGame();
  else if (room.gameType === 'tictactoe') room.game = new TicTacToeGame();
  else if (room.gameType === 'mancala') room.game = new MancalaGame();
  else if (room.gameType === 'checkers') room.game = new CheckersGame();
  else if (room.gameType === 'chess') room.game = new ChessGame();
  else if (room.gameType === 'morpion') room.game = new MorpionGame();
  else if (room.gameType === 'war') room.game = new WarGame();
  else if (room.gameType === 'speed') room.game = new SpeedGame();
  else if (room.gameType === 'poker') room.game = new PokerGame();
  else if (room.gameType === 'reversi') room.game = new ReversiGame();
  else if (room.gameType === 'connect4') room.game = new Connect4Game();
  else if (room.gameType === 'battleship') room.game = new BattleshipGame();
  else if (room.gameType === 'backgammon') room.game = new BackgammonGame();
  else if (room.gameType === 'rps') room.game = new RPSGame();
  else if (room.gameType === 'coinflip') room.game = new CoinFlipGame();
  else if (room.gameType === 'diceduel') room.game = new DiceDuelGame();
  else if (room.gameType === 'hilo') room.game = new HiLoGame();
  else if (room.gameType === 'dotsboxes') room.game = new DotsBoxesGame();
  else if (room.gameType === 'nim') room.game = new NimGame();
  else if (room.gameType === 'hex') room.game = new HexGame();
  else if (room.gameType === 'reaction') room.game = new ReactionGame();
  else if (room.gameType === 'memory') room.game = new MemoryGame();
  else if (room.gameType === 'mathduel') room.game = new MathDuelGame();
  room.game.init(room.players.length, room.options || {});

  room.players.forEach((sid, idx) => {
    const sock = io.sockets.sockets.get(sid);
    if (sock) {
      const p1 = players.get(room.players[0]);
      const p2 = players.get(room.players[1]);
      sock.emit('game_start', {
        roomId: room.id, gameType: room.gameType, betAmount: room.betAmount, playerIndex: idx,
        players: [
          { username: p1?.displayName, wallet: p1?.walletAddress },
          { username: p2?.displayName, wallet: p2?.walletAddress },
        ],
      });
    }
  });
  emitGameState(room);
  startTurnTimer(room);
}

function emitGameState(room) {
  room.players.forEach((sid, idx) => {
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.emit('game_state', room.game.getStateForPlayer(idx));
  });
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTurnTimer(room);
  room.players.forEach((sid) => {
    const p = players.get(sid);
    if (p) p.roomId = null;
    const s = io.sockets.sockets.get(sid);
    if (s) s.leave(roomId);
  });
  rooms.delete(roomId);
}

function broadcastLobby() {
  const waiting = [];
  for (const [key, val] of matchQueue) {
    const parts = key.split('_');
    const gameType = parts[0];
    const bet = parts[1];
    const gridSize = parts[2] || null;
    const p = players.get(val.socketId);
    waiting.push({
      id: key,
      gameType,
      betAmount: parseFloat(bet),
      username: p?.displayName || 'Anon',
      wallet: p?.walletAddress ? p.walletAddress.slice(0, 4) + '…' + p.walletAddress.slice(-4) : '',
      gridSize: gridSize ? parseInt(gridSize) : null,
      socketId: val.socketId,
    });
  }
  const activeGames = [];
  for (const [, room] of rooms) {
    if (room.state === 'playing') {
      activeGames.push({ gameType: room.gameType, betAmount: room.betAmount, players: room.players.map((sid) => players.get(sid)?.displayName) });
    }
  }
  const openSportsBets = [];
  for (const [, sb] of sportsBets) {
    if (sb.status === 'open') {
      openSportsBets.push({
        id: sb.id,
        eventId: sb.eventId,
        matchName: sb.matchName,
        league: sb.league,
        sportKey: sb.sportKey,
        pick: sb.pick,
        teamName: sb.teamName,
        betAmount: sb.betAmount,
        creatorName: sb.creatorName,
        creatorWallet: sb.creatorWallet ? sb.creatorWallet.slice(0, 4) + '…' + sb.creatorWallet.slice(-4) : '',
        creatorSocketId: sb.creatorSocketId,
        createdAt: sb.createdAt,
      });
    }
  }
  io.emit('lobby_update', { waiting, activeGames, onlineCount: players.size, openSportsBets });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`ZG (Zoot Games) running on http://localhost:${PORT}`);
});
