// Domino game UI renderer
const DominoUI = (() => {
  let selectedTileIndex = null;
  let sendActionFn = null;

  function render(state, sendAction) {
    sendActionFn = sendAction;
    renderBoard(state);
    renderControls(state);
  }

  function renderBoard(state) {
    const area = document.getElementById('game-area');
    const { board, boardLeft, boardRight, opponentTileCount, boneyardCount } = state;

    let html = '<div class="domino-board-wrapper">';

    // Opponent hand (face down)
    html += '<div class="domino-info">';
    html += `<span>Opponent: ${opponentTileCount} tiles</span>`;
    html += `<span>Pile: ${boneyardCount} tiles</span>`;
    html += '</div>';

    // Board chain
    html += '<div class="domino-board">';
    if (board.length === 0) {
      html += '<span style="color:#9ca3af;font-style:italic;">No tiles played yet — place the first tile!</span>';
    } else {
      board.forEach(tile => {
        html += renderTile(tile[0], tile[1]);
      });
    }
    html += '</div>';
    html += '</div>';

    area.innerHTML = html;
  }

  function renderControls(state) {
    const controls = document.getElementById('game-controls');
    const { hand, isMyTurn, canPlay, canDraw, board, boardLeft, boardRight } = state;

    let html = '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;">';

    // Player's hand
    html += '<div class="domino-hand">';
    hand.forEach((tile, idx) => {
      const selected = idx === selectedTileIndex ? ' selected' : '';
      html += `<div class="domino-tile${selected}" data-idx="${idx}" onclick="DominoUI.selectTile(${idx})">`;
      html += `<div class="half">${dotSymbol(tile[0])}</div>`;
      html += '<div class="divider"></div>';
      html += `<div class="half">${dotSymbol(tile[1])}</div>`;
      html += '</div>';
    });
    html += '</div>';

    // Action buttons
    if (isMyTurn) {
      html += '<div class="domino-actions">';

      if (selectedTileIndex !== null && board.length > 0) {
        const tile = hand[selectedTileIndex];
        const matchesLeft = tile[0] === boardLeft || tile[1] === boardLeft;
        const matchesRight = tile[0] === boardRight || tile[1] === boardRight;

        if (matchesLeft && matchesRight && boardLeft !== boardRight) {
          html += `<button class="side-btn" onclick="DominoUI.playTile('left')">◀ Left</button>`;
          html += `<button class="side-btn" onclick="DominoUI.playTile('right')">Right ▶</button>`;
        } else if (matchesLeft) {
          html += `<button class="side-btn" onclick="DominoUI.playTile('left')">◀ Play Left</button>`;
        } else if (matchesRight) {
          html += `<button class="side-btn" onclick="DominoUI.playTile('right')">Play Right ▶</button>`;
        } else {
          html += '<span style="color:#ef4444;font-size:0.8rem;">Tile doesn\'t match</span>';
        }
      } else if (selectedTileIndex !== null && board.length === 0) {
        html += `<button class="side-btn" onclick="DominoUI.playTile('right')">Play Tile</button>`;
      }

      if (canDraw) {
        html += `<button class="draw-btn" onclick="DominoUI.drawTile()">Draw from Pile</button>`;
      }

      if (!canPlay && !canDraw) {
        html += `<button class="pass-btn" onclick="DominoUI.passTurn()">Pass</button>`;
      }

      html += '</div>';
    } else {
      html += '<div class="domino-actions"><span style="color:#9ca3af;">Waiting for opponent...</span></div>';
    }

    html += '</div>';
    controls.innerHTML = html;
  }

  function renderTile(a, b) {
    return `<div class="domino-tile">` +
      `<div class="half">${dotSymbol(a)}</div>` +
      `<div class="divider"></div>` +
      `<div class="half">${dotSymbol(b)}</div>` +
      `</div>`;
  }

  function dotSymbol(n) {
    const dots = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    return n === 0 ? '·' : dots[n] || n;
  }

  function selectTile(idx) {
    selectedTileIndex = selectedTileIndex === idx ? null : idx;
    const socket = App.getSocket();
    if (socket) socket.emit('get_state_refresh');
    // Re-render controls with selection
    const controls = document.getElementById('game-controls');
    // We'll trigger re-render via a local state update
    const event = new CustomEvent('domino-rerender');
    document.dispatchEvent(event);
  }

  // Store last state so we can re-render on selection change
  let lastState = null;
  const originalRender = render;

  function renderWithState(state, sendAction) {
    lastState = state;
    sendActionFn = sendAction;
    renderBoard(state);
    renderControls(state);
  }

  document.addEventListener('domino-rerender', () => {
    if (lastState && sendActionFn) {
      renderControls(lastState);
    }
  });

  function playTile(side) {
    if (selectedTileIndex === null || !sendActionFn) return;
    sendActionFn({ type: 'play', tileIndex: selectedTileIndex, side });
    selectedTileIndex = null;
  }

  function drawTile() {
    if (!sendActionFn) return;
    sendActionFn({ type: 'draw' });
  }

  function passTurn() {
    if (!sendActionFn) return;
    sendActionFn({ type: 'pass' });
  }

  return {
    render: renderWithState,
    selectTile,
    playTile,
    drawTile,
    passTurn,
  };
})();
