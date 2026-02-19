// Main application controller
const App = (() => {
  let socket = null;
  let currentGame = null;
  let myPlayerIndex = null;
  let gameState = null;
  let playersInfo = null;

  // ── Screens ──
  const screens = {
    connect: document.getElementById('screen-connect'),
    lobby: document.getElementById('screen-lobby'),
    waiting: document.getElementById('screen-waiting'),
    game: document.getElementById('screen-game'),
  };

  function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  // ── Init ──
  function init() {
    setupConnectScreen();
    setupLobbyScreen();
    setupWaitingScreen();
    setupGameOverlay();
  }

  // ── Connect Screen ──
  function setupConnectScreen() {
    const btn = document.getElementById('btn-connect-wallet');
    const usernameInput = document.getElementById('username-input');

    btn.addEventListener('click', async () => {
      const username = usernameInput.value.trim();
      if (!username) {
        usernameInput.style.borderColor = '#ef4444';
        usernameInput.focus();
        return;
      }

      try {
        btn.textContent = 'Connecting...';
        btn.disabled = true;
        const { publicKey } = await Wallet.connect();

        socket = io();
        socket.on('connect', () => {
          socket.emit('register', { wallet: publicKey, username });
        });

        socket.on('registered', () => {
          document.getElementById('wallet-display').textContent = Wallet.shortenAddress(publicKey);
          document.getElementById('username-display').textContent = username;
          showScreen('lobby');
        });

        socket.on('waiting', ({ msg, betAmount, gameType }) => {
          document.getElementById('waiting-info').textContent =
            `${gameType.toUpperCase()} — ${betAmount} SOL bet`;
          showScreen('waiting');
        });

        socket.on('lobby_update', updateLobby);
        socket.on('game_start', onGameStart);
        socket.on('game_state', onGameState);
        socket.on('game_over', onGameOver);
        socket.on('search_cancelled', () => showScreen('lobby'));
        socket.on('error_msg', ({ msg }) => showToast(msg, 'error'));
      } catch (err) {
        showToast(err.message || 'Connection failed', 'error');
        btn.textContent = '◎ Connect Phantom Wallet';
        btn.disabled = false;
      }
    });
  }

  // ── Lobby ──
  function setupLobbyScreen() {
    document.querySelectorAll('.game-card').forEach(card => {
      // Bet selection
      card.querySelectorAll('.bet-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          card.querySelectorAll('.bet-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });

      // Find Match button
      card.querySelector('.btn-play').addEventListener('click', () => {
        const gameType = card.dataset.game;
        const activeBet = card.querySelector('.bet-btn.active');
        const betAmount = parseFloat(activeBet.dataset.bet);

        socket.emit('find_match', { gameType, betAmount });
      });
    });
  }

  function updateLobby({ waiting, activeGames, onlineCount }) {
    document.getElementById('online-count').textContent = `${onlineCount} online`;

    const waitList = document.getElementById('waiting-list');
    waitList.innerHTML = waiting.length === 0
      ? '<li class="empty-msg">No one waiting</li>'
      : waiting.map(w =>
          `<li><span>${w.username} — ${w.gameType}</span><span>${w.betAmount} SOL</span></li>`
        ).join('');

    const activeList = document.getElementById('active-list');
    activeList.innerHTML = activeGames.length === 0
      ? '<li class="empty-msg">No active games</li>'
      : activeGames.map(g =>
          `<li><span>${g.players.join(' vs ')}</span><span>${g.gameType} — ${g.betAmount} SOL</span></li>`
        ).join('');
  }

  // ── Waiting ──
  function setupWaitingScreen() {
    document.getElementById('btn-cancel-search').addEventListener('click', () => {
      socket.emit('cancel_search');
    });
  }

  // ── Game Start ──
  function onGameStart(data) {
    currentGame = data.gameType;
    myPlayerIndex = data.playerIndex;
    playersInfo = data.players;

    document.getElementById('game-type-label').textContent = data.gameType.toUpperCase();
    document.getElementById('game-bet-label').textContent = data.betAmount + ' SOL';
    document.getElementById('player1-label').textContent = data.players[0].username;
    document.getElementById('player2-label').textContent = data.players[1].username;

    // Highlight current player's name
    if (data.playerIndex === 0) {
      document.getElementById('player1-label').style.color = '#8b5cf6';
    } else {
      document.getElementById('player2-label').style.color = '#8b5cf6';
    }

    showScreen('game');
  }

  // ── Game State ──
  function onGameState(state) {
    gameState = state;

    const turnEl = document.getElementById('turn-indicator');
    if (state.isMyTurn) {
      turnEl.textContent = 'YOUR TURN';
      turnEl.className = 'turn-indicator my-turn';
    } else {
      turnEl.textContent = 'OPPONENT\'S TURN';
      turnEl.className = 'turn-indicator their-turn';
    }

    if (state.gameType === 'domino') {
      DominoUI.render(state, sendAction);
    } else if (state.gameType === 'tictactoe') {
      TicTacToeUI.render(state, sendAction);
    }
  }

  function sendAction(action) {
    if (socket) socket.emit('game_action', action);
  }

  // ── Game Over ──
  function onGameOver(data) {
    const overlay = document.getElementById('overlay-gameover');
    const title = document.getElementById('gameover-title');
    const detail = document.getElementById('gameover-detail');
    const payout = document.getElementById('gameover-payout');

    if (data.isDraw) {
      title.textContent = 'DRAW!';
      title.style.color = '#f59e0b';
      detail.textContent = 'Nobody wins — bets returned.';
      payout.textContent = '';
    } else {
      const iWon = data.winnerWallet === Wallet.getPublicKey();
      title.textContent = iWon ? 'YOU WIN!' : 'YOU LOSE';
      title.style.color = iWon ? '#10b981' : '#ef4444';
      detail.textContent = data.reason
        ? `${data.winner} wins — ${data.reason}`
        : `${data.winner} wins!`;
      payout.textContent = iWon ? `+${data.payout.toFixed(3)} SOL` : '';
    }

    overlay.classList.remove('hidden');
  }

  function setupGameOverlay() {
    document.getElementById('btn-back-lobby').addEventListener('click', () => {
      document.getElementById('overlay-gameover').classList.add('hidden');
      currentGame = null;
      gameState = null;
      showScreen('lobby');
      if (socket) socket.emit('get_lobby');
    });
  }

  // ── Toast notifications ──
  function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 9999;
      background: ${type === 'error' ? '#ef4444' : '#8b5cf6'}; color: #fff;
      padding: 0.8rem 1.2rem; border-radius: 8px; font-size: 0.9rem;
      font-weight: 600; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      animation: fadeIn 0.3s ease;
    `;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }

  // Expose for other modules
  function getSocket() { return socket; }
  function getPlayerIndex() { return myPlayerIndex; }

  document.addEventListener('DOMContentLoaded', init);

  return { showScreen, getSocket, getPlayerIndex, sendAction };
})();
