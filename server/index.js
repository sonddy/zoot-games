require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
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
const players = new Map();     // socketId -> { wallet, username, roomId }
const matchQueue = new Map();  // gameType -> [{ socketId, bet }]

function createRoom(gameType, betAmount, player1Socket) {
  const id = uuidv4().slice(0, 8);
  const room = {
    id,
    gameType,
    betAmount,
    players: [player1Socket],
    state: 'waiting', // waiting | playing | finished
    game: null,
    createdAt: Date.now(),
  };
  rooms.set(id, room);
  return room;
}

function getMaxPlayers(gameType) {
  return gameType === 'tictactoe' ? 2 : 2; // domino 1v1 for now
}

// ── Socket.IO ──
io.on('connection', (socket) => {
  console.log(`⚡ Connected: ${socket.id}`);

  socket.on('register', ({ wallet, username }) => {
    players.set(socket.id, { wallet, username, roomId: null });
    socket.emit('registered', { success: true });
    broadcastLobby();
  });

  // ── Find / Create a match ──
  socket.on('find_match', ({ gameType, betAmount, gridSize }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const opts = {};
    if (gameType === 'tictactoe' && gridSize) opts.gridSize = gridSize;

    const queueKey = `${gameType}_${betAmount}${gridSize ? '_' + gridSize : ''}`;
    if (matchQueue.has(queueKey)) {
      const waiting = matchQueue.get(queueKey);
      matchQueue.delete(queueKey);

      const room = createRoom(gameType, betAmount, waiting.socketId);
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
      matchQueue.set(queueKey, { socketId: socket.id, bet: betAmount, options: opts });
      socket.emit('waiting', { msg: 'Waiting for an opponent...', betAmount, gameType });
    }
    broadcastLobby();
  });

  socket.on('cancel_search', () => {
    for (const [key, val] of matchQueue) {
      if (val.socketId === socket.id) {
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
      const winnerSocketId = winnerIdx !== null ? room.players[winnerIdx] : null;
      const winnerPlayer = winnerSocketId ? players.get(winnerSocketId) : null;

      io.to(room.id).emit('game_over', {
        winner: winnerPlayer ? winnerPlayer.username : null,
        winnerWallet: winnerPlayer ? winnerPlayer.wallet : null,
        payout: winnerIdx !== null ? room.betAmount * 2 * 0.95 : 0, // 5% house fee
        isDraw: winnerIdx === null,
      });

      setTimeout(() => cleanupRoom(room.id), 5000);
    }
  });

  socket.on('get_lobby', () => broadcastLobby());

  socket.on('disconnect', () => {
    console.log(`🔌 Disconnected: ${socket.id}`);
    const player = players.get(socket.id);

    // Remove from matchmaking queue
    for (const [key, val] of matchQueue) {
      if (val.socketId === socket.id) {
        matchQueue.delete(key);
        break;
      }
    }

    // Handle in-game disconnect (opponent wins)
    if (player && player.roomId) {
      const room = rooms.get(player.roomId);
      if (room && room.state === 'playing') {
        const remainingIdx = room.players.indexOf(socket.id) === 0 ? 1 : 0;
        const winnerSocketId = room.players[remainingIdx];
        const winnerPlayer = players.get(winnerSocketId);
        io.to(room.id).emit('game_over', {
          winner: winnerPlayer ? winnerPlayer.username : null,
          winnerWallet: winnerPlayer ? winnerPlayer.wallet : null,
          payout: room.betAmount * 2 * 0.95,
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
