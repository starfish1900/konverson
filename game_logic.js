// --- CONFIG & SHARED STATE ---
// This object will be initialized by the orchestrator and passed to helpers.
let CONFIG = {};

// --- ZOBRIST HASHING ---
let zobristTable, zobristTurn;

function initZobrist(boardSize) {
    const maxPieces = 8; // 4 colors, 2 postures
    zobristTable = Array(boardSize).fill(null).map(() =>
        Array(boardSize).fill(null).map(() =>
            Array.from({ length: maxPieces }, () => Math.floor(Math.random() * 2 ** 32))
        )
    );
    zobristTurn = Array.from({ length: 4 }, () => Math.floor(Math.random() * 2 ** 32));
}

function getPieceIndex(piece) {
    const colorMap = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };
    const postureOffset = piece.posture === 'new' ? 0 : 4;
    return colorMap[piece.color] + postureOffset;
}

function computeHash(board, playerIndex) {
    let h = 0;
    for (let r = 0; r < CONFIG.boardSize; r++) {
        for (let c = 0; c < CONFIG.boardSize; c++) {
            if (board[r][c]) h ^= zobristTable[r][c][getPieceIndex(board[r][c])];
        }
    }
    h ^= zobristTurn[playerIndex];
    return h;
}


// --- CORE HELPER FUNCTIONS ---
const isValid = (r, c) => r >= 0 && r < CONFIG.boardSize && c >= 0 && c < CONFIG.boardSize;
const getSquexType = (r, c) => {
    const isCorner = (r === 0 || r === CONFIG.boardSize - 1) && (c === 0 || c === CONFIG.boardSize - 1);
    if (isCorner) return 'corner';
    const isBorder = r === 0 || r === CONFIG.boardSize - 1 || c === 0 || c === CONFIG.boardSize - 1;
    if (isBorder) return 'border';
    const isPreborder = (r === 1 || r === CONFIG.boardSize - 2) || (c === 1 || c === CONFIG.boardSize - 2);
    if (isPreborder) return 'preborder';
    return 'interior';
};
const isNear = (r1, c1, r2, c2) => Math.abs(r1 - r2) <= 2 && Math.abs(c1 - c2) <= 2;
const isEnemy = (pieceColor, playerColor) => pieceColor && pieceColor !== playerColor && CONFIG.ALLIANCES[playerColor] !== pieceColor;

// --- PLACEMENT AND MOVE LOGIC ---
function isValidPlacement(r, c, currentBoard, turnPlacements) {
    if (currentBoard[r][c]) return false;
    for (const p of turnPlacements) { if (isNear(r, c, p.r, p.c)) return false; }
    const type = getSquexType(r, c);
    if (type === 'interior') return true;
    let isBoardEmpty = true;
    for (let i = 0; i < currentBoard.length; i++) {
        for (let j = 0; j < currentBoard[i].length; j++) {
            if (currentBoard[i][j]) { isBoardEmpty = false; break; }
        }
        if (!isBoardEmpty) break;
    }
    if (isBoardEmpty && turnPlacements.length === 0) return false;
    let hasRequiredNeighbor = false;
    for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr, nc = c + dc;
            if (!isValid(nr, nc) || !currentBoard[nr][nc]) continue;
            const neighborType = getSquexType(nr, nc);
            if (type === 'preborder' && neighborType === 'interior') hasRequiredNeighbor = true;
            if (type === 'border' && neighborType === 'preborder') hasRequiredNeighbor = true;
            if (type === 'corner' && Math.abs(dr) === 1 && Math.abs(dc) === 1 && neighborType === 'preborder') hasRequiredNeighbor = true;
        }
    }
    return hasRequiredNeighbor;
}

function getConversions(r, c, color, currentBoard) {
    const changes = [];
    const directions = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
    directions.forEach(([dr, dc]) => {
        const captured = []; let lineColor = null;
        for (let i = 1; i < CONFIG.boardSize; i++) {
            const cr = r + i * dr, cc = c + i * dc;
            if (!isValid(cr, cc) || !currentBoard[cr][cc]) break;
            const piece = currentBoard[cr][cc];
            if (i === 1) {
                if (piece.posture === 'new' || piece.color === color) break;
                lineColor = piece.color; captured.push({ r: cr, c: cc });
            } else {
                if (piece.color === lineColor && piece.posture === 'old') captured.push({ r: cr, c: cc });
                else if (piece.color === color) { captured.forEach(p => changes.push(p)); break; }
                else break;
            }
        }
    });
    return changes;
}

function applyMove(board, move, playerColor) {
    const newBoard = board.map(row => row.map(cell => cell ? { ...cell } : null));
    for (let r = 0; r < CONFIG.boardSize; r++) {
        for (let c = 0; c < CONFIG.boardSize; c++) {
            const piece = newBoard[r][c];
            if (piece?.color === playerColor && piece?.posture === 'new') {
                piece.posture = 'old';
            }
        }
    }
    move.forEach(p => { newBoard[p.r][p.c] = { color: playerColor, posture: 'new' }; });
    move.forEach(p => {
        const conversions = getConversions(p.r, p.c, playerColor, newBoard);
        conversions.forEach(conv => { newBoard[conv.r][conv.c].color = playerColor; });
    });
    return newBoard;
}

function getOrderedMoves(board, turnCount, playerColor) {
    const singlePlacements = [];
    for (let r = 0; r < CONFIG.boardSize; r++) {
        for (let c = 0; c < CONFIG.boardSize; c++) {
            if (isValidPlacement(r, c, board, [])) singlePlacements.push({ r, c });
        }
    }
    const pawnsToPlace = turnCount === 1 ? 1 : (singlePlacements.length >= 2 ? 2 : singlePlacements.length);
    if (pawnsToPlace === 0) return [];

    const scoredSingles = singlePlacements.map(p => {
        let score = 0;
        if (getSquexType(p.r, p.c) === 'corner') score -= CONFIG.CORNER_PLACEMENT_PENALTY;
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const nr = p.r + dr, nc = p.c + dc;
                if (isValid(nr, nc) && board[nr][nc] && isEnemy(board[nr][nc].color, playerColor)) {
                    score += CONFIG.CONTACT_BONUS;
                }
            }
        }
        return { placement: p, score };
    }).sort((a, b) => b.score - a.score);

    if (pawnsToPlace === 1) {
        return scoredSingles.map(s => ({ move: [s.placement], score: s.score }));
    }

    const candidateSingles = scoredSingles.slice(0, CONFIG.CANDIDATE_SINGLES_LIMIT);
    const candidateMap = new Map(candidateSingles.map(s => [`${s.placement.r},${s.placement.c}`, s.score]));
    const doubleMoves = [];
    for (let i = 0; i < candidateSingles.length; i++) {
        for (let j = i + 1; j < candidateSingles.length; j++) {
            const p1 = candidateSingles[i].placement;
            const p2 = candidateSingles[j].placement;
            if (!isNear(p1.r, p1.c, p2.r, p2.c)) {
                const score1 = candidateMap.get(`${p1.r},${p1.c}`) || 0;
                const score2 = candidateMap.get(`${p2.r},${p2.c}`) || 0;
                doubleMoves.push({ move: [p1, p2], score: score1 + score2 });
            }
        }
    }
    doubleMoves.sort((a, b) => b.score - a.score);

    if (doubleMoves.length > 0) return doubleMoves;

    if (singlePlacements.length >= 2) { // Fallback for no valid doubles in candidates
        for (let i = 0; i < singlePlacements.length; i++) {
            for (let j = i + 1; j < singlePlacements.length; j++) {
                const p1 = singlePlacements[i], p2 = singlePlacements[j];
                if (!isNear(p1.r, p1.c, p2.r, p2.c)) return [{ move: [p1, p2], score: 0 }];
            }
        }
    }
    return scoredSingles.length > 0 ? [{ move: [scoredSingles[0].placement], score: scoredSingles[0].score }] : [];
}

// --- WIN CONDITION & EVALUATION ---
function checkWinCondition(board) {
    for (const color of CONFIG.COLORS) {
        const path = hasConnection(color, board);
        if (path) {
            return { winner: color, path: path };
        }
    }
    return null;
}

function hasConnection(color, board) {
    const isCorner = (r, c) => getSquexType(r, c) === 'corner';
    const visitedNS = Array(CONFIG.boardSize).fill(null).map(() => Array(CONFIG.boardSize).fill(false));
    for (let c = 0; c < CONFIG.boardSize; c++) {
        if (board[0][c]?.color === color && !isCorner(0, c)) {
            const path = bfs(0, c, color, 'S', visitedNS, board);
            if (path) return path;
        }
    }
    const visitedEW = Array(CONFIG.boardSize).fill(null).map(() => Array(CONFIG.boardSize).fill(false));
    for (let r = 0; r < CONFIG.boardSize; r++) {
        if (board[r][0]?.color === color && !isCorner(r, 0)) {
            const path = bfs(r, 0, color, 'E', visitedEW, board);
            if (path) return path;
        }
    }
    return null;
}

function bfs(startR, startC, color, targetSide, visited, board) {
    if (visited[startR][startC]) return null;
    const queue = [{ r: startR, c: startC }];
    const parent = new Map();
    parent.set(`${startR},${startC}`, null);
    visited[startR][startC] = true;
    let queueIndex = 0;
    let endNode = null;

    while (queueIndex < queue.length) {
        const { r, c } = queue[queueIndex++];
        if ((targetSide === 'S' && r === CONFIG.boardSize - 1) || (targetSide === 'E' && c === CONFIG.boardSize - 1)) {
            endNode = { r, c };
            break;
        }
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const nr = r + dr, nc = c + dc;
                if (isValid(nr, nc) && !visited[nr][nc] && board[nr][nc]?.color === color && getSquexType(nr, nc) !== 'corner') {
                    visited[nr][nc] = true;
                    parent.set(`${nr},${nc}`, { r, c });
                    queue.push({ r: nr, c: nc });
                }
            }
        }
    }

    if (!endNode) return null;
    const path = [];
    let current = endNode;
    while(current) {
        path.unshift(current);
        current = parent.get(`${current.r},${current.c}`);
    }
    return path;
}


function evaluate(board) {
    const winInfo = checkWinCondition(board);
    if (winInfo && winInfo.winner) {
        return CONFIG.PLAYER_TEAMS[winInfo.winner] === 1 ? CONFIG.WIN_SCORE : -CONFIG.WIN_SCORE;
    }
    let team1PieceCount = 0, team2PieceCount = 0;
    let team1CornerPenalty = 0, team2CornerPenalty = 0;
    let team1ExtentBonus = 0, team2ExtentBonus = 0;
    const visited = Array(CONFIG.boardSize).fill(null).map(() => Array(CONFIG.boardSize).fill(false));
    for (let r = 0; r < CONFIG.boardSize; r++) {
        for (let c = 0; c < CONFIG.boardSize; c++) {
            const piece = board[r][c];
            if (piece) {
                const team = CONFIG.PLAYER_TEAMS[piece.color];
                if (team === 1) {
                    team1PieceCount++;
                    if (getSquexType(r, c) === 'corner') team1CornerPenalty += CONFIG.STATIC_CORNER_PENALTY;
                } else {
                    team2PieceCount++;
                    if (getSquexType(r, c) === 'corner') team2CornerPenalty += CONFIG.STATIC_CORNER_PENALTY;
                }

                if (!visited[r][c]) {
                    let minR = r, maxR = r, minC = c, maxC = c;
                    const queue = [{ r, c }];
                    visited[r][c] = true;
                    let qIdx = 0;
                    while (qIdx < queue.length) {
                        const curr = queue[qIdx++];
                        minR = Math.min(minR, curr.r); maxR = Math.max(maxR, curr.r);
                        minC = Math.min(minC, curr.c); maxC = Math.max(maxC, curr.c);
                        for (let dr = -1; dr <= 1; dr++) {
                            for (let dc = -1; dc <= 1; dc++) {
                                if (dr === 0 && dc === 0) continue;
                                const nr = curr.r + dr, nc = curr.c + dc;
                                if (isValid(nr, nc) && !visited[nr][nc] && board[nr][nc] && CONFIG.PLAYER_TEAMS[board[nr][nc].color] === team) {
                                    visited[nr][nc] = true;
                                    queue.push({ r: nr, c: nc });
                                }
                            }
                        }
                    }
                    const extent = Math.max(maxR - minR, maxC - minC);
                    const bonus = extent * extent * CONFIG.EXTENT_BONUS_MULTIPLIER;
                    if (team === 1) team1ExtentBonus += bonus; else team2ExtentBonus += bonus;
                }
            }
        }
    }
    const pieceAdvantage = (team1PieceCount - team2PieceCount) * CONFIG.PIECE_VALUE;
    return pieceAdvantage + team1ExtentBonus - team2ExtentBonus - team1CornerPenalty + team2CornerPenalty;
}