require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Keypair } = require('@solana/web3.js');
const DominoGame = require('./games/domino');
const TicTacToeGame = require('./games/tictactoe');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── In-memory state ──
const rooms = new Map();       // roomId -> Room
const players = new Map();     // socketId -> { wallet, username, roomId, platformWallet }
const matchQueue = new Map();  // queueKey -> { socketId, bet, options }
const wallets = new Map();     // platformWalletAddress -> { balance, owner (wallet/username), transactions[] }

const HOUSE_FEE = 0.05;

function generatePlatformWallet() {
  const kp = Keypair.generate();
  return kp.publicKey.toBase58();
}

function getOrCreateWallet(walletId) {
  if (!wallets.has(walletId)) {
    const platformAddr = generatePlatformWallet();
    wallets.set(walletId, {
      platformWallet: platformAddr,
      balance: 0,
      transactions: [],
    });
  }
  return wallets.get(walletId);
}

function createRoom(gameType, betAmount, player1Socket) {
  const id = uuidv4().slice(0, 8);
  const room = {
    id,
    gameType,
    betAmount,
    players: [player1Socket],
    state: 'waiting',
    game: null,
    createdAt: Date.now(),
  };
  rooms.set(id, room);
  return room;
}

// ── Socket.IO ──
io.on('connection', (socket) => {
  console.log(`⚡ Connected: ${socket.id}`);

  socket.on('register', ({ wallet, username }) => {
    const w = getOrCreateWallet(wallet);
    players.set(socket.id, { wallet, username, roomId: null, platformWallet: w.platformWallet });
    socket.emit('registered', {
      success: true,
      platformWallet: w.platformWallet,
      balance: w.balance,
    });
    broadcastLobby();
  });

  // ── Wallet: deposit (simulated — in production this would verify on-chain) ──
  socket.on('deposit', ({ amount }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return socket.emit('error_msg', { msg: 'Invalid amount' });

    const w = getOrCreateWallet(player.wallet);
    w.balance += amt;
    w.transactions.push({ type: 'deposit', amount: amt, date: Date.now() });
    socket.emit('balance_update', { balance: w.balance, tx: { type: 'deposit', amount: amt } });
  });

  // ── Wallet: withdraw ──
  socket.on('withdraw', ({ amount, toAddress }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return socket.emit('error_msg', { msg: 'Invalid amount' });

    const w = getOrCreateWallet(player.wallet);
    if (w.balance < amt) return socket.emit('error_msg', { msg: 'Insufficient balance' });

    w.balance -= amt;
    w.transactions.push({ type: 'withdraw', amount: amt, to: toAddress || player.wallet, date: Date.now() });
    socket.emit('balance_update', { balance: w.balance, tx: { type: 'withdraw', amount: amt } });
  });

  // ── Get balance ──
  socket.on('get_balance', () => {
    const player = players.get(socket.id);
    if (!player) return;
    const w = getOrCreateWallet(player.wallet);
    socket.emit('balance_update', { balance: w.balance });
  });

  // ── Find / Create a match ──
  socket.on('find_match', ({ gameType, betAmount, gridSize }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const bet = parseFloat(betAmount);
    if (!bet || bet <= 0) return socket.emit('error_msg', { msg: 'Invalid bet amount' });

    const w = getOrCreateWallet(player.wallet);
    if (w.balance < bet) {
      return socket.emit('error_msg', { msg: 'Insufficient balance. Deposit SOL first!' });
    }

    // Deduct bet immediately (held in escrow)
    w.balance -= bet;
    socket.emit('balance_update', { balance: w.balance });

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
      matchQueue.set(queueKey, { socketId: socket.id, bet, options: opts });
      socket.emit('waiting', { msg: 'Waiting for an opponent...', betAmount: bet, gameType });
    }
    broadcastLobby();
  });

  socket.on('cancel_search', () => {
    for (const [key, val] of matchQueue) {
      if (val.socketId === socket.id) {
        // Refund the held bet
        const player = players.get(socket.id);
        if (player) {
          const w = getOrCreateWallet(player.wallet);
          w.balance += val.bet;
          socket.emit('balance_update', { balance: w.balance });
        }
        matchQueue.delete(key);
        break;
      }
    }
    socket.emit('search_cancelled');
    broadcastLobby();
  });

  // ── Game actions ──
  socket.on('game_action', (action) => {
    const player = players.get(socket.id);
    if (!player || !player.roomId) return;
    const room = rooms.get(player.roomId);
    if (!room || !room.game) return;

    const playerIndex = room.players.indexOf(socket.id);
    const result = room.game.handleAction(playerIndex, action);

    if (result.error) {
      return socket.emit('error_msg', { msg: result.error });
    }

    emitGameState(room);

    if (result.gameOver) {
      room.state = 'finished';
      const winnerIdx = result.winner;
      const pot = room.betAmount * 2;
      const houseCut = pot * HOUSE_FEE;
      const payout = pot - houseCut;

      if (winnerIdx !== null) {
        const winnerSocketId = room.players[winnerIdx];
        const winnerPlayer = players.get(winnerSocketId);
        if (winnerPlayer) {
          const ww = getOrCreateWallet(winnerPlayer.wallet);
          ww.balance += payout;
          ww.transactions.push({ type: 'win', amount: payout, date: Date.now() });
          const winSock = io.sockets.sockets.get(winnerSocketId);
          if (winSock) winSock.emit('balance_update', { balance: ww.balance });
        }

        io.to(room.id).emit('game_over', {
          winner: winnerPlayer ? winnerPlayer.username : null,
          winnerWallet: winnerPlayer ? winnerPlayer.wallet : null,
          payout,
          isDraw: false,
        });
      } else {
        // Draw — refund both players
        room.players.forEach((sid) => {
          const p = players.get(sid);
          if (p) {
            const pw = getOrCreateWallet(p.wallet);
            pw.balance += room.betAmount;
            pw.transactions.push({ type: 'refund', amount: room.betAmount, date: Date.now() });
            const s = io.sockets.sockets.get(sid);
            if (s) s.emit('balance_update', { balance: pw.balance });
          }
        });
        io.to(room.id).emit('game_over', {
          winner: null, winnerWallet: null, payout: 0, isDraw: true,
        });
      }

      setTimeout(() => cleanupRoom(room.id), 5000);
    }
  });

  socket.on('get_lobby', () => broadcastLobby());

  socket.on('disconnect', () => {
    console.log(`🔌 Disconnected: ${socket.id}`);
    const player = players.get(socket.id);

    // Refund from matchmaking queue
    for (const [key, val] of matchQueue) {
      if (val.socketId === socket.id) {
        if (player) {
          const w = getOrCreateWallet(player.wallet);
          w.balance += val.bet;
        }
        matchQueue.delete(key);
        break;
      }
    }

    // Handle in-game disconnect (opponent wins, get the pot)
    if (player && player.roomId) {
      const room = rooms.get(player.roomId);
      if (room && room.state === 'playing') {
        const remainingIdx = room.players.indexOf(socket.id) === 0 ? 1 : 0;
        const winnerSocketId = room.players[remainingIdx];
        const winnerPlayer = players.get(winnerSocketId);

        const pot = room.betAmount * 2;
        const payout = pot - (pot * HOUSE_FEE);

        if (winnerPlayer) {
          const ww = getOrCreateWallet(winnerPlayer.wallet);
          ww.balance += payout;
          ww.transactions.push({ type: 'win_disconnect', amount: payout, date: Date.now() });
          const winSock = io.sockets.sockets.get(winnerSocketId);
          if (winSock) winSock.emit('balance_update', { balance: ww.balance });
        }

        io.to(room.id).emit('game_over', {
          winner: winnerPlayer ? winnerPlayer.username : null,
          winnerWallet: winnerPlayer ? winnerPlayer.wallet : null,
          payout,
          isDraw: false,
          reason: 'Opponent disconnected',
        });
        room.state = 'finished';
        setTimeout(() => cleanupRoom(room.id), 3000);
      }
    }

    players.delete(socket.id);
    broadcastLobby();
  });
});

function startGame(room) {
  if (room.gameType === 'domino') {
    room.game = new DominoGame();
  } else if (room.gameType === 'tictactoe') {
    room.game = new TicTacToeGame();
  }
  room.game.init(room.players.length, room.options || {});

  room.players.forEach((sid, idx) => {
    const sock = io.sockets.sockets.get(sid);
    if (sock) {
      const p1 = players.get(room.players[0]);
      const p2 = players.get(room.players[1]);
      sock.emit('game_start', {
        roomId: room.id,
        gameType: room.gameType,
        betAmount: room.betAmount,
        playerIndex: idx,
        players: [
          { username: p1?.username, wallet: p1?.wallet },
          { username: p2?.username, wallet: p2?.wallet },
        ],
      });
    }
  });

  emitGameState(room);
}

function emitGameState(room) {
  room.players.forEach((sid, idx) => {
    const sock = io.sockets.sockets.get(sid);
    if (sock) {
      sock.emit('game_state', room.game.getStateForPlayer(idx));
    }
  });
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
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
    const [gameType, bet] = key.split('_');
    const p = players.get(val.socketId);
    waiting.push({ gameType, betAmount: parseFloat(bet), username: p?.username });
  }

  const activeGames = [];
  for (const [, room] of rooms) {
    if (room.state === 'playing') {
      activeGames.push({
        gameType: room.gameType,
        betAmount: room.betAmount,
        players: room.players.map((sid) => players.get(sid)?.username),
      });
    }
  }

  const onlineCount = players.size;
  io.emit('lobby_update', { waiting, activeGames, onlineCount });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 ZG (Zoot Games) running on http://localhost:${PORT}`);
});
