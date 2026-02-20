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

// ── In-memory state ──
const rooms = new Map();
const players = new Map();     // socketId -> { uid, email, displayName, wallet, roomId }
const matchQueue = new Map();
const userBalances = new Map(); // uid -> { balance, platformWallet }

const HOUSE_FEE = 0.05;

async function getUserData(uid) {
  if (userBalances.has(uid)) return userBalances.get(uid);

  let userData = null;
  if (db) {
    try {
      const t0 = Date.now();
      const doc = await db.collection('users').doc(uid).get();
      console.log(`Firestore read took ${Date.now() - t0}ms`);
      if (doc.exists) {
        userData = doc.data();
      }
    } catch (e) {
      console.error('Firestore read error:', e.message);
    }
  }

  if (!userData) {
    const t0 = Date.now();
    const kp = Keypair.generate();
    console.log(`Keypair generation took ${Date.now() - t0}ms`);
    userData = {
      platformWallet: kp.publicKey.toBase58(),
      privateKey: Buffer.from(kp.secretKey).toString('base64'),
      balance: 0,
      lastOnChainBalance: 0,
      createdAt: Date.now(),
    };
    if (db) {
      db.collection('users').doc(uid).set(userData).catch(e =>
        console.error('Firestore write error:', e.message)
      );
    }
  }

  userBalances.set(uid, userData);
  return userData;
}

async function saveBalance(uid) {
  const data = userBalances.get(uid);
  if (!data || !db) return;
  try {
    await db.collection('users').doc(uid).update({
      balance: data.balance,
      lastOnChainBalance: data.lastOnChainBalance || 0,
    });
  } catch (e) {
    console.error('Firestore balance save error:', e.message);
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

  socket.on('register', async ({ idToken, displayName }) => {
    const regStart = Date.now();
    let uid, email, name;

    if (fbAuth && idToken) {
      try {
        const t0 = Date.now();
        const decoded = await fbAuth.verifyIdToken(idToken);
        console.log(`verifyIdToken took ${Date.now() - t0}ms`);
        uid = decoded.uid;
        email = decoded.email;
        name = displayName || decoded.name || email.split('@')[0];
      } catch (e) {
        return socket.emit('error_msg', { msg: 'Authentication failed' });
      }
    } else {
      uid = 'local_' + socket.id;
      email = 'local@zootgames';
      name = displayName || 'Player';
    }

    const userData = await getUserData(uid);
    console.log(`Total register took ${Date.now() - regStart}ms`);
    players.set(socket.id, {
      uid, email, displayName: name,
      wallet: userData.platformWallet,
      roomId: null,
    });

    socket.emit('registered', {
      success: true,
      uid,
      email,
      displayName: name,
      platformWallet: userData.platformWallet,
      privateKey: userData.privateKey,
      balance: userData.balance,
    });
    broadcastLobby();
  });

  socket.on('check_deposit', async () => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const data = userBalances.get(player.uid);
    if (!data) return;

    try {
      const pubKey = new PublicKey(data.platformWallet);
      const lamports = await solanaConnection.getBalance(pubKey);
      const onChainSOL = lamports / LAMPORTS_PER_SOL;

      const lastOnChain = data.lastOnChainBalance || 0;
      const deposited = onChainSOL - lastOnChain;

      if (deposited > 0.000001) {
        data.balance += deposited;
        data.lastOnChainBalance = onChainSOL;
        await saveBalance(player.uid);
        socket.emit('balance_update', {
          balance: data.balance,
          onChainBalance: onChainSOL,
          tx: { type: 'deposit', amount: parseFloat(deposited.toFixed(6)) },
        });
      } else {
        socket.emit('balance_update', {
          balance: data.balance,
          onChainBalance: onChainSOL,
        });
      }
    } catch (e) {
      console.error('Check deposit error:', e.message);
      socket.emit('error_msg', { msg: 'Failed to check on-chain balance' });
    }
  });

  socket.on('withdraw', async ({ amount, toAddress }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return socket.emit('error_msg', { msg: 'Invalid amount' });
    if (!toAddress || toAddress.length < 32) return socket.emit('error_msg', { msg: 'Provide a valid Solana wallet address' });

    const data = userBalances.get(player.uid);
    if (!data) return;
    if (data.balance < amt) return socket.emit('error_msg', { msg: 'Insufficient platform balance' });

    try {
      let destPubKey;
      try { destPubKey = new PublicKey(toAddress); } catch (_) {
        return socket.emit('error_msg', { msg: 'Invalid destination address' });
      }

      const secretKey = Buffer.from(data.privateKey, 'base64');
      const fromKeypair = Keypair.fromSecretKey(secretKey);
      const lamportsToSend = Math.floor(amt * LAMPORTS_PER_SOL);

      const walletBalance = await solanaConnection.getBalance(fromKeypair.publicKey);
      if (walletBalance < lamportsToSend + 5000) {
        return socket.emit('error_msg', { msg: 'Not enough SOL in wallet for withdrawal + fees. On-chain: ' + (walletBalance / LAMPORTS_PER_SOL).toFixed(6) + ' SOL' });
      }

      socket.emit('withdraw_status', { status: 'processing', msg: 'Sending transaction...' });

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: fromKeypair.publicKey,
          toPubkey: destPubKey,
          lamports: lamportsToSend,
        })
      );
      const signature = await sendAndConfirmTransaction(solanaConnection, tx, [fromKeypair]);

      data.balance -= amt;
      const newOnChain = await solanaConnection.getBalance(fromKeypair.publicKey);
      data.lastOnChainBalance = newOnChain / LAMPORTS_PER_SOL;
      await saveBalance(player.uid);

      socket.emit('balance_update', {
        balance: data.balance,
        onChainBalance: data.lastOnChainBalance,
        tx: { type: 'withdraw', amount: amt, signature, toAddress },
      });
      socket.emit('withdraw_status', { status: 'success', signature, msg: 'Withdrawal confirmed!' });
    } catch (e) {
      console.error('Withdraw error:', e.message);
      socket.emit('withdraw_status', { status: 'error', msg: 'Transaction failed: ' + e.message });
      socket.emit('error_msg', { msg: 'Withdrawal failed: ' + e.message });
    }
  });

  socket.on('get_balance', async () => {
    const player = players.get(socket.id);
    if (!player) return;
    const data = userBalances.get(player.uid);
    if (!data) return;

    try {
      const pubKey = new PublicKey(data.platformWallet);
      const lamports = await solanaConnection.getBalance(pubKey);
      socket.emit('balance_update', {
        balance: data.balance,
        onChainBalance: lamports / LAMPORTS_PER_SOL,
      });
    } catch (e) {
      socket.emit('balance_update', { balance: data.balance });
    }
  });

  socket.on('find_match', async ({ gameType, betAmount, gridSize }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const bet = parseFloat(betAmount);
    if (!bet || bet <= 0) return socket.emit('error_msg', { msg: 'Invalid bet amount' });

    const data = userBalances.get(player.uid);
    if (!data || data.balance < bet) {
      return socket.emit('error_msg', { msg: 'Insufficient balance. Deposit SOL first!' });
    }

    data.balance -= bet;
    await saveBalance(player.uid);
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
          const data = userBalances.get(player.uid);
          if (data) {
            data.balance += val.bet;
            await saveBalance(player.uid);
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
          const wd = userBalances.get(winnerPlayer.uid);
          if (wd) {
            wd.balance += payout;
            await saveBalance(winnerPlayer.uid);
            const winSock = io.sockets.sockets.get(winnerSocketId);
            if (winSock) winSock.emit('balance_update', { balance: wd.balance });
          }
        }
        io.to(room.id).emit('game_over', {
          winner: winnerPlayer ? winnerPlayer.displayName : null,
          winnerWallet: winnerPlayer ? winnerPlayer.wallet : null,
          payout, isDraw: false,
        });
      } else {
        for (const sid of room.players) {
          const p = players.get(sid);
          if (p) {
            const pd = userBalances.get(p.uid);
            if (pd) {
              pd.balance += room.betAmount;
              await saveBalance(p.uid);
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
          const data = userBalances.get(player.uid);
          if (data) {
            data.balance += val.bet;
            await saveBalance(player.uid);
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
          const wd = userBalances.get(winnerPlayer.uid);
          if (wd) {
            wd.balance += payout;
            await saveBalance(winnerPlayer.uid);
            const winSock = io.sockets.sockets.get(winnerSocketId);
            if (winSock) winSock.emit('balance_update', { balance: wd.balance });
          }
        }

        io.to(room.id).emit('game_over', {
          winner: winnerPlayer ? winnerPlayer.displayName : null,
          winnerWallet: winnerPlayer ? winnerPlayer.wallet : null,
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
          { username: p1?.displayName, wallet: p1?.wallet },
          { username: p2?.displayName, wallet: p2?.wallet },
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
