// Tic Tac Toe UI renderer
const TicTacToeUI = (() => {
  let sendActionFn = null;

  function render(state, sendAction) {
    sendActionFn = sendAction;
    renderBoard(state);
    renderControls(state);
  }

  function renderBoard(state) {
    const area = document.getElementById('game-area');
    const { board, isMyTurn, symbol } = state;

    let html = '<div class="ttt-wrapper">';
    html += `<p style="text-align:center;margin-bottom:1rem;color:#9ca3af;">You are <strong style="color:${symbol === 'X' ? '#a78bfa' : '#f59e0b'};font-size:1.3rem;">${symbol}</strong></p>`;
    html += '<div class="ttt-grid">';

    for (let i = 0; i < 9; i++) {
      const val = board[i];
      let cellClass = 'ttt-cell';
      let content = '';

      if (val === 0) {
        cellClass += ' x taken';
        content = 'X';
      } else if (val === 1) {
        cellClass += ' o taken';
        content = 'O';
      }

      const clickable = val === null && isMyTurn;
      const onclick = clickable ? `onclick="TicTacToeUI.placeAt(${i})"` : '';

      html += `<div class="${cellClass}" ${onclick}>${content}</div>`;
    }

    html += '</div>';
    html += '</div>';

    area.innerHTML = html;
  }

  function renderControls(state) {
    const controls = document.getElementById('game-controls');
    if (state.isMyTurn) {
      controls.innerHTML = '<p style="text-align:center;color:#10b981;font-weight:600;">Click a cell to place your mark!</p>';
    } else {
      controls.innerHTML = '<p style="text-align:center;color:#9ca3af;">Waiting for opponent to play...</p>';
    }
  }

  function placeAt(cell) {
    if (sendActionFn) {
      sendActionFn({ type: 'place', cell });
    }
  }

  return { render, placeAt };
})();
