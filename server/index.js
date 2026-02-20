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

const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
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

const rooms = new Map();
const players = new Map();
const matchQueue = new Map();
const usedSignatures = new Set();

const HOUSE_FEE = 0.05;

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
  const room = { id, gameType, betAmount, players: [player1Socket], state: 'waiting', game: null, createdAt: Date.now() };
  rooms.set(id, room);
  return room;
}

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on('register', async ({ walletAddress, displayName }) => {
    if (!walletAddress || walletAddress.length < 32) return socket.emit('error_msg', { msg: 'Invalid wallet address' });
    try { new PublicKey(walletAddress); } catch (_) { return socket.emit('error_msg', { msg: 'Invalid Solana address' }); }

    players.set(socket.id, { walletAddress, displayName: displayName || walletAddress.slice(0, 6), roomId: null });

    socket.emit('registered', {
      success: true,
      walletAddress,
      displayName: displayName || walletAddress.slice(0, 6),
      escrowAddress: ESCROW_ADDRESS,
    });
    broadcastLobby();
  });

  socket.on('find_match', async ({ gameType, betAmount, gridSize, txSignature }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const bet = parseFloat(betAmount);
    if (!bet || bet <= 0) return socket.emit('error_msg', { msg: 'Invalid bet amount' });
    if (!txSignature) return socket.emit('error_msg', { msg: 'No payment transaction provided' });

    const verification = await verifyBetPayment(txSignature, bet);
    if (!verification.ok) return socket.emit('error_msg', { msg: verification.error });

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
        if (player) {
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
      room.state = 'finished';
      const winnerIdx = result.winner;
      const pot = room.betAmount * 2;
      const houseCut = pot * HOUSE_FEE;
      const payout = pot - houseCut;

      if (winnerIdx !== null) {
        const winnerSocketId = room.players[winnerIdx];
        const winnerPlayer = players.get(winnerSocketId);
        if (winnerPlayer) {
          try {
            const sig = await sendSOL(winnerPlayer.walletAddress, payout);
            const winSock = io.sockets.sockets.get(winnerSocketId);
            if (winSock) winSock.emit('balance_update', { refreshWallet: true, msg: 'You won ' + payout.toFixed(3) + ' SOL!' });
          } catch (e) {
            console.error('Payout error:', e.message);
          }
        }
        io.to(room.id).emit('game_over', {
          winner: winnerPlayer ? winnerPlayer.displayName : null,
          winnerWallet: winnerPlayer ? winnerPlayer.walletAddress : null,
          payout, isDraw: false,
        });
      } else {
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
        io.to(room.id).emit('game_over', { winner: null, winnerWallet: null, payout: 0, isDraw: true });
      }
      setTimeout(() => cleanupRoom(room.id), 5000);
    }
  });

  socket.on('get_lobby', () => broadcastLobby());

  socket.on('disconnect', async () => {
    console.log(`Disconnected: ${socket.id}`);
    const player = players.get(socket.id);

    for (const [key, val] of matchQueue) {
      if (val.socketId === socket.id) {
        if (player) {
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
        const payout = pot - (pot * HOUSE_FEE);

        if (winnerPlayer) {
          try {
            await sendSOL(winnerPlayer.walletAddress, payout);
            const winSock = io.sockets.sockets.get(winnerSocketId);
            if (winSock) winSock.emit('balance_update', { refreshWallet: true, msg: 'Opponent left — you won ' + payout.toFixed(3) + ' SOL!' });
          } catch (e) { console.error('Payout on disconnect:', e.message); }
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

    players.delete(socket.id);
    broadcastLobby();
  });
});

function startGame(room) {
  if (room.gameType === 'domino') room.game = new DominoGame();
  else if (room.gameType === 'tictactoe') room.game = new TicTacToeGame();
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
    waiting.push({ gameType, betAmount: parseFloat(bet), username: p?.displayName });
  }
  const activeGames = [];
  for (const [, room] of rooms) {
    if (room.state === 'playing') {
      activeGames.push({ gameType: room.gameType, betAmount: room.betAmount, players: room.players.map((sid) => players.get(sid)?.displayName) });
    }
  }
  io.emit('lobby_update', { waiting, activeGames, onlineCount: players.size });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`ZG (Zoot Games) running on http://localhost:${PORT}`);
});
