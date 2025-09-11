'use strict';

// Import the shared logic
importScripts('game_logic.js');

const TT_EXACT = 0, TT_ALPHA = 1, TT_BETA = 2;
let transpositionTable = new Map();
let historyTable = [];

function getConversionMoves(board, turnCount, playerColor) {
    const allMoves = getOrderedMoves(board, turnCount, playerColor);
    const conversionMoves = [];

    for (const moveObj of allMoves) {
        const tempBoard = board.map(row => row.map(cell => cell ? { ...cell } : null));
        moveObj.move.forEach(p => {
            tempBoard[p.r][p.c] = { color: playerColor, posture: 'new' };
        });

        let totalConversions = 0;
        moveObj.move.forEach(p => {
            totalConversions += getConversions(p.r, p.c, playerColor, tempBoard).length;
        });

        if (totalConversions > 0) {
            conversionMoves.push({ move: moveObj.move, conversions: totalConversions });
        }
    }
    return conversionMoves.sort((a, b) => b.conversions - a.conversions);
}

const Q_SEARCH_MAX_DEPTH = 2;

/**
 * --- NEW: NegaMax Quiescence Search ---
 * Refactored to fit the NegaMax framework. It returns a score from the perspective of the current player.
 */
function quiescenceSearch(board, depth, alpha, beta, playerIndex, turnCount) {
    const playerColor = CONFIG.COLORS[playerIndex];
    const multiplier = (CONFIG.PLAYER_TEAMS[playerColor] === 1) ? 1 : -1;

    const winInfo = checkWinCondition(board);
    if (winInfo) {
        return evaluate(board) * multiplier; // Return score from current player's perspective
    }
    
    const stand_pat = evaluate(board) * multiplier; // Get evaluation from current player's perspective

    if (stand_pat >= beta) return beta; // Fail-hard beta cutoff
    
    alpha = Math.max(alpha, stand_pat);

    if (depth === 0) return alpha;

    const moves = getConversionMoves(board, turnCount, playerColor);
    if (moves.length === 0) return alpha;
    
    for (const moveObj of moves) {
        const newBoard = applyMove(board, moveObj.move, playerColor);
        const nextPlayerIndex = (playerIndex + 1) % 4;
        const score = -quiescenceSearch(newBoard, depth - 1, -beta, -alpha, nextPlayerIndex, turnCount + 1);
        alpha = Math.max(alpha, score);
        if (alpha >= beta) return beta; // Prune
    }
    return alpha;
}


/**
 * --- NEW: NegaMax with Principal Variation Search (PVS) ---
 * The search is now implemented in a NegaMax style, which simplifies the logic.
 * 1. The first move is assumed to be the best (the Principal Variation) and is searched with a full (alpha, beta) window.
 * 2. Subsequent moves are first tested with a highly efficient "null window" search (-alpha - 1, -alpha).
 * 3. Only if a null window search indicates a move could be better than the current best, it is re-searched with the full window.
 */
function alphaBeta(board, depth, alpha, beta, playerIndex, turnCount) {
    const originalAlpha = alpha;
    const hash = computeHash(board, playerIndex);
    const ttEntry = transpositionTable.get(hash);

    if (ttEntry && ttEntry.depth >= depth) {
        if (ttEntry.flag === TT_EXACT) return ttEntry.score;
        if (ttEntry.flag === TT_ALPHA && ttEntry.score <= alpha) return alpha;
        if (ttEntry.flag === TT_BETA && ttEntry.score >= beta) return beta;
    }

    if (depth === 0) {
        return quiescenceSearch(board, Q_SEARCH_MAX_DEPTH, alpha, beta, playerIndex, turnCount);
    }
    
    const winInfo = checkWinCondition(board);
    if (winInfo) {
        const playerColor = CONFIG.COLORS[playerIndex];
        const multiplier = (CONFIG.PLAYER_TEAMS[playerColor] === 1) ? 1 : -1;
        return evaluate(board) * multiplier;
    }
    
    const playerColor = CONFIG.COLORS[playerIndex];
    const orderedMoves = getOrderedMoves(board, turnCount, playerColor);
    
    for (const moveObj of orderedMoves) {
        let historyScore = 0;
        for (const placement of moveObj.move) {
            historyScore += historyTable[placement.r][placement.c];
        }
        moveObj.score += historyScore;
    }
    orderedMoves.sort((a, b) => b.score - a.score);

    if (orderedMoves.length === 0) {
        const multiplier = (CONFIG.PLAYER_TEAMS[playerColor] === 1) ? 1 : -1;
        return evaluate(board) * multiplier;
    }

    let bestValue = -Infinity;
    let moveIndex = 0;

    for (const moveObj of orderedMoves) {
        const newBoard = applyMove(board, moveObj.move, playerColor);
        const nextPlayerIndex = (playerIndex + 1) % 4;
        
        let score;
        if (moveIndex === 0) {
            // --- PVS: Full window search for the first move ---
            score = -alphaBeta(newBoard, depth - 1, -beta, -alpha, nextPlayerIndex, turnCount + 1);
        } else {
            // --- PVS: Null-window search for subsequent moves ---
            score = -alphaBeta(newBoard, depth - 1, -alpha - 1, -alpha, nextPlayerIndex, turnCount + 1);

            // If it's promising, re-search with the full window
            if (score > alpha && score < beta) {
                score = -alphaBeta(newBoard, depth - 1, -beta, -alpha, nextPlayerIndex, turnCount + 1);
            }
        }
        moveIndex++;

        bestValue = Math.max(bestValue, score);
        alpha = Math.max(alpha, bestValue);

        if (alpha >= beta) {
            for (const placement of moveObj.move) {
                 historyTable[placement.r][placement.c] += depth * depth;
            }
            break; // Prune
        }
    }

    let flag = TT_EXACT;
    if (bestValue <= originalAlpha) flag = TT_BETA;
    else if (bestValue >= beta) flag = TT_ALPHA;
    transpositionTable.set(hash, { score: bestValue, depth, flag });
    
    return bestValue;
}

// Listen for jobs from the orchestrator
self.onmessage = (e) => {
    if (e.data.type === 'init') {
        CONFIG = e.data.config;
        zobristTable = e.data.zobrist;
        zobristTurn = e.data.zobristT;
        transpositionTable.clear();
        return;
    }
    
    const { jobId, board, depth, alpha, beta, playerIndex, turnCount, config } = e.data;
    CONFIG = config; 

    if (!historyTable.length || historyTable.length !== CONFIG.boardSize) {
        historyTable = Array(CONFIG.boardSize).fill(0).map(() => Array(CONFIG.boardSize).fill(0));
    }

    const score = alphaBeta(board, depth, alpha, beta, playerIndex, turnCount);

    self.postMessage({ jobId, score });
};