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

// Platform escrow wallet — holds all deposited funds for bets
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

let db = null;
let fbAuth = null;
try {
  const fb = require('./firebase');
  db = fb.db;
  fbAuth = fb.auth;
  console.log('Firebase initialized');
} catch (e) {
  console.warn('Firebase not configured — running without persistence');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// REST endpoint to get escrow address (frontend needs it for deposits)
app.get('/api/escrow', (req, res) => {
  res.json({ escrowAddress: ESCROW_ADDRESS });
});

// ── In-memory state ──
const rooms = new Map();
const players = new Map();     // socketId -> { walletAddress, displayName, roomId }
const matchQueue = new Map();
const userBalances = new Map(); // walletAddress -> { balance }

const HOUSE_FEE = 0.05;

async function getUserBalance(walletAddress) {
  if (userBalances.has(walletAddress)) return userBalances.get(walletAddress);

  let data = null;
  if (db) {
    try {
      const doc = await db.collection('wallets').doc(walletAddress).get();
      if (doc.exists) data = doc.data();
    } catch (e) {
      console.error('Firestore read error:', e.message);
    }
  }

  if (!data) {
    data = { balance: 0, createdAt: Date.now() };
  }

  userBalances.set(walletAddress, data);
  return data;
}

async function saveBalance(walletAddress) {
  const data = userBalances.get(walletAddress);
  if (!data || !db) return;
  try {
    await db.collection('wallets').doc(walletAddress).set({
      balance: data.balance,
      lastUpdated: Date.now(),
    }, { merge: true });
  } catch (e) {
    console.error('Firestore save error:', e.message);
  }
}

function createRoom(gameType, betAmount, player1Socket) {
  const id = uuidv4().slice(0, 8);
  const room = {
    id, gameType, betAmount,
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
  console.log(`Connected: ${socket.id}`);

  socket.on('register', async ({ walletAddress, displayName }) => {
    if (!walletAddress || walletAddress.length < 32) {
      return socket.emit('error_msg', { msg: 'Invalid wallet address' });
    }

    try { new PublicKey(walletAddress); } catch (_) {
      return socket.emit('error_msg', { msg: 'Invalid Solana wallet address' });
    }

    const data = await getUserBalance(walletAddress);

    players.set(socket.id, {
      walletAddress,
      displayName: displayName || walletAddress.slice(0, 6),
      roomId: null,
    });

    socket.emit('registered', {
      success: true,
      walletAddress,
      displayName: displayName || walletAddress.slice(0, 6),
      balance: data.balance,
      escrowAddress: ESCROW_ADDRESS,
    });
    broadcastLobby();
  });

  // Confirm deposit — client sends tx signature, server verifies on-chain
  socket.on('confirm_deposit', async ({ signature, amount }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    try {
      const tx = await solanaConnection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!tx || tx.meta.err) {
        return socket.emit('error_msg', { msg: 'Transaction not found or failed' });
      }

      const escrowPubKey = escrowKeypair.publicKey;
      const accountKeys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
      const escrowIndex = accountKeys.findIndex(k => k.toBase58() === ESCROW_ADDRESS);

      if (escrowIndex === -1) {
        return socket.emit('error_msg', { msg: 'Transaction does not involve the escrow wallet' });
      }

      const preBalance = tx.meta.preBalances[escrowIndex];
      const postBalance = tx.meta.postBalances[escrowIndex];
      const receivedLamports = postBalance - preBalance;
      const receivedSOL = receivedLamports / LAMPORTS_PER_SOL;

      if (receivedSOL < 0.000001) {
        return socket.emit('error_msg', { msg: 'No SOL received by escrow in this transaction' });
      }

      const data = userBalances.get(player.walletAddress);
      data.balance += receivedSOL;
      await saveBalance(player.walletAddress);

      socket.emit('balance_update', {
        balance: data.balance,
        tx: { type: 'deposit', amount: parseFloat(receivedSOL.toFixed(6)), signature },
      });
    } catch (e) {
      console.error('Confirm deposit error:', e.message);
      socket.emit('error_msg', { msg: 'Failed to verify deposit: ' + e.message });
    }
  });

  // Withdraw — server sends SOL from escrow to player's wallet
  socket.on('withdraw', async ({ amount }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return socket.emit('error_msg', { msg: 'Invalid amount' });

    const data = userBalances.get(player.walletAddress);
    if (!data) return;
    if (data.balance < amt) return socket.emit('error_msg', { msg: 'Insufficient platform balance' });

    try {
      const destPubKey = new PublicKey(player.walletAddress);
      const lamportsToSend = Math.floor(amt * LAMPORTS_PER_SOL);

      const escrowBalance = await solanaConnection.getBalance(escrowKeypair.publicKey);
      if (escrowBalance < lamportsToSend + 5000) {
        return socket.emit('error_msg', { msg: 'Escrow wallet has insufficient funds. Contact support.' });
      }

      socket.emit('withdraw_status', { status: 'processing', msg: 'Sending SOL to your wallet...' });

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: escrowKeypair.publicKey,
          toPubkey: destPubKey,
          lamports: lamportsToSend,
        })
      );
      const signature = await sendAndConfirmTransaction(solanaConnection, tx, [escrowKeypair]);

      data.balance -= amt;
      await saveBalance(player.walletAddress);

      socket.emit('balance_update', {
        balance: data.balance,
        tx: { type: 'withdraw', amount: amt, signature },
      });
      socket.emit('withdraw_status', { status: 'success', signature, msg: 'Withdrawal confirmed!' });
    } catch (e) {
      console.error('Withdraw error:', e.message);
      socket.emit('withdraw_status', { status: 'error', msg: 'Transaction failed: ' + e.message });
    }
  });

  socket.on('get_balance', () => {
    const player = players.get(socket.id);
    if (!player) return;
    const data = userBalances.get(player.walletAddress);
    if (data) socket.emit('balance_update', { balance: data.balance });
  });

  socket.on('find_match', async ({ gameType, betAmount, gridSize }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const bet = parseFloat(betAmount);
    if (!bet || bet <= 0) return socket.emit('error_msg', { msg: 'Invalid bet amount' });

    const data = userBalances.get(player.walletAddress);
    if (!data || data.balance < bet) {
      return socket.emit('error_msg', { msg: 'Insufficient balance. Deposit SOL first!' });
    }

    data.balance -= bet;
    await saveBalance(player.walletAddress);
    socket.emit('balance_update', { balance: data.balance });

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

  socket.on('cancel_search', async () => {
    for (const [key, val] of matchQueue) {
      if (val.socketId === socket.id) {
        const player = players.get(socket.id);
        if (player) {
          const data = userBalances.get(player.walletAddress);
          if (data) {
            data.balance += val.bet;
            await saveBalance(player.walletAddress);
            socket.emit('balance_update', { balance: data.balance });
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
          const wd = userBalances.get(winnerPlayer.walletAddress);
          if (wd) {
            wd.balance += payout;
            await saveBalance(winnerPlayer.walletAddress);
            const winSock = io.sockets.sockets.get(winnerSocketId);
            if (winSock) winSock.emit('balance_update', { balance: wd.balance });
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
            const pd = userBalances.get(p.walletAddress);
            if (pd) {
              pd.balance += room.betAmount;
              await saveBalance(p.walletAddress);
              const s = io.sockets.sockets.get(sid);
              if (s) s.emit('balance_update', { balance: pd.balance });
            }
          }
        }
        io.to(room.id).emit('game_over', {
          winner: null, winnerWallet: null, payout: 0, isDraw: true,
        });
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
          const data = userBalances.get(player.walletAddress);
          if (data) {
            data.balance += val.bet;
            await saveBalance(player.walletAddress);
          }
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
          const wd = userBalances.get(winnerPlayer.walletAddress);
          if (wd) {
            wd.balance += payout;
            await saveBalance(winnerPlayer.walletAddress);
            const winSock = io.sockets.sockets.get(winnerSocketId);
            if (winSock) winSock.emit('balance_update', { balance: wd.balance });
          }
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
      activeGames.push({
        gameType: room.gameType,
        betAmount: room.betAmount,
        players: room.players.map((sid) => players.get(sid)?.displayName),
      });
    }
  }
  io.emit('lobby_update', { waiting, activeGames, onlineCount: players.size });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`ZG (Zoot Games) running on http://localhost:${PORT}`);
});
