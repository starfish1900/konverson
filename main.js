document.addEventListener('DOMContentLoaded', () => {

    // --- CONFIGURATION ---
    let BOARD_SIZE = 11;
    const COLORS = ['A', 'B', 'C', 'D'];
    const ALLIANCES = { 'A': 'C', 'C': 'A', 'B': 'D', 'D': 'B' };
    const PLAYER_TEAMS = { 'A': 1, 'C': 1, 'B': 2, 'D': 2 };
    const HUMAN_TEAMS = [1];
    const AI_TEAMS = [2];

    // --- AI CONFIGURATION ---
    const AI_SEARCH_TIME_MS = 3000;
    const AI_MAX_DEPTH = 24; 
    const CANDIDATE_SINGLES_LIMIT = 169;
    const PIECE_VALUE = 100;
    const CONVERSION_BONUS_PER_PIECE = 50; // NEW: High bonus for each conversion
    const ADJACENCY_BONUS = 5;             // NEW: Small bonus for touching an enemy
    const EXTENT_BONUS_MULTIPLIER = 5;
    const CORNER_PLACEMENT_PENALTY = 200;
    const STATIC_CORNER_PENALTY = 50;
    const WIN_SCORE = 100000;

    // --- DOM ELEMENTS & GAME STATE ---
    const boardElement = document.getElementById('board');
    const turnIndicator = document.getElementById('turn-indicator');
    const infoIndicator = document.getElementById('info-indicator');
    const resetButton = document.getElementById('reset-button');
    const boardSizeSelector = document.getElementById('board-size-selector');
    const turnColorIndicator = document.getElementById('turn-color-indicator');
    let board = [], currentPlayerIndex = 0, turnCount = 0, placementsThisTurn = [], pawnsToPlace = 0, gameOver = false, aiWorker = null;

    // --- HELPER FUNCTIONS ---
    // NOTE: Game logic functions like isValid, getSquexType, etc., are now in game_logic.js
    const getPlayerColor = () => COLORS[currentPlayerIndex];
    const isHumanTurn = () => HUMAN_TEAMS.includes(PLAYER_TEAMS[getPlayerColor()]);
    
    // --- CORE GAME LOGIC ---
    // Inside main.js

function initGame() {
    if (aiWorker) aiWorker.terminate();
    BOARD_SIZE = parseInt(boardSizeSelector.value, 10);
    
    // --- THIS IS THE CRITICAL SECTION TO CHECK ---
    // It must contain the new CONVERSION and ADJACENCY bonus lines
    // and must NOT contain the old CONTACT_BONUS line.

    CONFIG.boardSize = BOARD_SIZE;
    CONFIG.COLORS = COLORS;
    CONFIG.ALLIANCES = ALLIANCES;
    CONFIG.PLAYER_TEAMS = PLAYER_TEAMS;
    CONFIG.AI_SEARCH_TIME_MS = AI_SEARCH_TIME_MS;
    CONFIG.AI_MAX_DEPTH = AI_MAX_DEPTH;
    CONFIG.CANDIDATE_SINGLES_LIMIT = CANDIDATE_SINGLES_LIMIT;
    CONFIG.PIECE_VALUE = PIECE_VALUE;
    CONFIG.CONVERSION_BONUS_PER_PIECE = CONVERSION_BONUS_PER_PIECE; // MUST BE PRESENT
    CONFIG.ADJACENCY_BONUS = ADJACENCY_BONUS;                     // MUST BE PRESENT
    CONFIG.EXTENT_BONUS_MULTIPLIER = EXTENT_BONUS_MULTIPLIER;
    CONFIG.CORNER_PLACEMENT_PENALTY = CORNER_PLACEMENT_PENALTY;
    CONFIG.STATIC_CORNER_PENALTY = STATIC_CORNER_PENALTY;
    CONFIG.WIN_SCORE = WIN_SCORE;
    // --- END OF CRITICAL SECTION ---


    board = Array(BOARD_SIZE).fill(null).map(() => Array(BOARD_SIZE).fill(null));
    currentPlayerIndex = 0; turnCount = 0; placementsThisTurn = []; pawnsToPlace = 1; gameOver = false;
    boardSizeSelector.disabled = false; resetButton.disabled = false;
    boardElement.innerHTML = '';
    boardElement.style.gridTemplateColumns = `repeat(${BOARD_SIZE}, 1fr)`;
    boardElement.style.gridTemplateRows = `repeat(${BOARD_SIZE}, 1fr)`;
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const square = document.createElement('div');
            square.classList.add('board-square', getSquexType(r, c));
            square.dataset.r = r;
            square.dataset.c = c;
            square.addEventListener('click', () => handleSquareClick(r, c));
            boardElement.appendChild(square);
        }
    }
    startTurn();
}

    function renderBoard() {
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                const square = boardElement.children[r * BOARD_SIZE + c];
                square.innerHTML = '';
                if (!square.classList.contains('winning-piece')) {
                    square.classList.remove('valid-move', 'selected-placement');
                }
                if (board[r][c]) {
                    const piece = document.createElement('div');
                    piece.classList.add('piece', `color-${board[r][c].color}`, `posture-${board[r][c].posture}`);
                    square.appendChild(piece);
                }
            }
        }
        placementsThisTurn.forEach(({r, c}) => {
            const square = boardElement.children[r * BOARD_SIZE + c];
            if(square) square.classList.add('selected-placement');
        });
    }

    function updateStatus() {
        if (gameOver) return;
        const color = getPlayerColor();
        const team = PLAYER_TEAMS[color];
        turnIndicator.textContent = `Turn: ${color} (Team ${team})`;
        const cssVarColor = `var(--color-${color.toLowerCase()})`;
        turnIndicator.style.color = cssVarColor;
        turnColorIndicator.style.backgroundColor = cssVarColor;
        infoIndicator.textContent = isHumanTurn() ? `Place ${pawnsToPlace - placementsThisTurn.length} more pawn(s).` : 'AI is thinking...';
    }

    function startTurn() {
        turnCount++;
        const color = getPlayerColor();
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                if (board[r][c]?.color === color && board[r][c]?.posture === 'new') {
                    board[r][c].posture = 'old';
                }
            }
        }
        placementsThisTurn = [];
        const legalPlacements = getAllValidSinglePlacements(board);
        pawnsToPlace = turnCount === 1 ? 1 : (legalPlacements.length >= 2 ? 2 : legalPlacements.length);
        if (pawnsToPlace === 0 && turnCount > 1) {
            endGame(null, true);
            return;
        }
        renderBoard();
        updateStatus();
        if (!isHumanTurn()) {
            setTimeout(aiMove, 100);
        } else {
            highlightValidMoves();
        }
    }

    function handleSquareClick(r, c) {
        if (gameOver || !isHumanTurn() || !isValidPlacement(r, c, board, placementsThisTurn)) return;
        
        placementsThisTurn.push({ r, c });
        const color = getPlayerColor();
        board[r][c] = { color, posture: 'new' };
        
        const conversions = getConversions(r, c, color, board);
        conversions.forEach(conv => { board[conv.r][conv.c].color = color; });
        
        renderBoard();

        const winInfo = checkWinCondition(board);
        if (winInfo && winInfo.winner) {
            animateWinningChain(winInfo.path, winInfo.winner);
            return;
        }
        if (placementsThisTurn.length === pawnsToPlace) {
            advanceToNextTurn();
        } else {
            highlightValidMoves();
            updateStatus();
        }
    }

    function advanceToNextTurn() {
        currentPlayerIndex = (currentPlayerIndex + 1) % COLORS.length;
        startTurn();
    }
    
    function getAllValidSinglePlacements(currentBoard) {
        const placements = [];
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                if (isValidPlacement(r, c, currentBoard, [])) placements.push({r, c});
            }
        }
        return placements;
    }

    function highlightValidMoves() {
        document.querySelectorAll('.board-square').forEach(s => s.classList.remove('valid-move'));
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                if (isValidPlacement(r, c, board, placementsThisTurn)) boardElement.children[r * BOARD_SIZE + c].classList.add('valid-move');
            }
        }
    }

    function animateWinningChain(path, winner) {
        gameOver = true; boardSizeSelector.disabled = true; resetButton.disabled = true;
        document.querySelectorAll('.board-square').forEach(s => s.classList.remove('valid-move', 'selected-placement'));
        if (path) {
            path.forEach(({r, c}) => { if (boardElement.children[r * BOARD_SIZE + c]) boardElement.children[r * BOARD_SIZE + c].classList.add('winning-piece'); });
        }
        setTimeout(() => endGame(winner), 3000);
    }

    function endGame(winner, isDraw = false) {
        if (aiWorker) { aiWorker.terminate(); aiWorker = null; }
        gameOver = true; boardSizeSelector.disabled = false; resetButton.disabled = false;
        if (isDraw) {
            turnIndicator.textContent = "It's a draw!"; turnIndicator.style.color = '#e0e0e0';
            infoIndicator.textContent = "No valid moves. Reset to play again."; turnColorIndicator.style.backgroundColor = '#4a4a4a';
        } else {
            const winningTeam = PLAYER_TEAMS[winner];
            const cssVarColor = `var(--color-${winner.toLowerCase()})`;
            turnIndicator.textContent = `${winner} (Team ${winningTeam}) wins!`; turnIndicator.style.color = cssVarColor;
            infoIndicator.textContent = "Game Over. Reset to play again."; turnColorIndicator.style.backgroundColor = cssVarColor;
        }
    }
    
    resetButton.addEventListener('click', initGame);
    boardSizeSelector.addEventListener('change', initGame);
   
    function aiMove() {
        if (aiWorker) {
            aiWorker.terminate();
        }

        aiWorker = new Worker('ai_orchestrator.js');

        aiWorker.onmessage = (e) => {
            const { bestMove } = e.data;
            
            if (bestMove && bestMove.length > 0) {
                placementsThisTurn = bestMove;
                const playerColor = getPlayerColor();
                const tempBoard = applyMove(board, bestMove, playerColor);
                board = tempBoard;
                
                renderBoard();
                
                const winInfo = checkWinCondition(board);
                if (winInfo && winInfo.winner) {
                    animateWinningChain(winInfo.path, winInfo.winner);
                    return;
                }
                advanceToNextTurn();
            } else {
                console.error("AI couldn't find a valid move.");
                endGame(null, true);
            }
            aiWorker.terminate();
            aiWorker = null;
        };

        aiWorker.onerror = (e) => {
            console.error('Error in AI Orchestrator Worker:', e.message, e);
            if (aiWorker) {
                aiWorker.terminate();
                aiWorker = null;
            }
        };

        aiWorker.postMessage({
            board,
            currentPlayerIndex,
            turnCount,
            boardSize: BOARD_SIZE,
            config: CONFIG
        });
    }
    initGame();
});