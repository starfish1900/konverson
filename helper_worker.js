'use strict';

// Import the shared logic
importScripts('game_logic.js');

const TT_EXACT = 0, TT_ALPHA = 1, TT_BETA = 2;
// The TT is a persistent variable inside the worker.
let transpositionTable = new Map();

/**
 * Generates only moves that result in at least one conversion.
 * It also attaches the number of conversions for sorting and pruning.
 */
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
            conversionMoves.push({
                move: moveObj.move,
                conversions: totalConversions
            });
        }
    }

    // Sort moves by the number of conversions they generate, most first.
    return conversionMoves.sort((a, b) => b.conversions - a.conversions);
}


const Q_SEARCH_MAX_DEPTH = 2; // Limit quiescence search to this many extra moves.

function quiescenceSearch(board, depth, alpha, beta, playerIndex, turnCount) {
    const winInfo = checkWinCondition(board);
    if (winInfo) return evaluate(board);

    if (depth === 0) {
        return evaluate(board);
    }
    
    const stand_pat = evaluate(board);
    const playerColor = CONFIG.COLORS[playerIndex];
    const isMaximizingPlayer = CONFIG.PLAYER_TEAMS[playerColor] === 1;

    if (isMaximizingPlayer) {
        if (stand_pat >= beta) return beta;
        if (stand_pat > alpha) alpha = stand_pat;
    } else { // Minimizing player
        if (stand_pat <= alpha) return alpha;
        if (stand_pat < beta) beta = stand_pat;
    }

    const moves = getConversionMoves(board, turnCount, playerColor);
    if (moves.length === 0) {
        return stand_pat;
    }

    let bestValue = stand_pat;

    for (const moveObj of moves) {
        const estimatedGain = moveObj.conversions * CONFIG.PIECE_VALUE;
        const futilityMargin = CONFIG.PIECE_VALUE;
        
        if (isMaximizingPlayer) {
            if (stand_pat + estimatedGain + futilityMargin < alpha) {
                continue;
            }
        }

        const newBoard = applyMove(board, moveObj.move, playerColor);
        const nextPlayerIndex = (playerIndex + 1) % 4;
        const value = quiescenceSearch(newBoard, depth - 1, alpha, beta, nextPlayerIndex, turnCount + 1);

        if (isMaximizingPlayer) {
            bestValue = Math.max(bestValue, value);
            alpha = Math.max(alpha, bestValue);
        } else {
            bestValue = Math.min(bestValue, value);
            beta = Math.min(beta, bestValue);
        }
        if (beta <= alpha) break;
    }

    return bestValue;
}


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
    if (winInfo) return evaluate(board);
    
    const playerColor = CONFIG.COLORS[playerIndex];
    const isMaximizingPlayer = CONFIG.PLAYER_TEAMS[playerColor] === 1;

    // --- START: NEW NULL-MOVE PRUNING LOGIC ---
    const R = 3; // Depth reduction factor
    if (depth >= R) {
        const nextPlayerIndex = (playerIndex + 1) % 4;
        const nullScore = alphaBeta(board, depth - 1 - R, alpha, beta, nextPlayerIndex, turnCount + 1);

        if (isMaximizingPlayer && nullScore >= beta) {
            return beta; // Prune
        }
        if (!isMaximizingPlayer && nullScore <= alpha) {
            return alpha; // Prune
        }
    }
    // --- END: NEW NULL-MOVE PRUNING LOGIC ---

    const orderedMoves = getOrderedMoves(board, turnCount, playerColor);
    
    if (orderedMoves.length === 0) {
        return evaluate(board);
    }

    let bestValue = isMaximizingPlayer ? -Infinity : Infinity;

    for (const moveObj of orderedMoves) {
        const newBoard = applyMove(board, moveObj.move, playerColor);
        const nextPlayerIndex = (playerIndex + 1) % 4;
        const value = alphaBeta(newBoard, depth - 1, alpha, beta, nextPlayerIndex, turnCount + 1);

        if (isMaximizingPlayer) {
            bestValue = Math.max(bestValue, value);
            alpha = Math.max(alpha, bestValue);
        } else {
            bestValue = Math.min(bestValue, value);
            beta = Math.min(beta, bestValue);
        }
        if (beta <= alpha) break;
    }

    let flag = TT_EXACT;
    if (bestValue <= originalAlpha) flag = TT_BETA;
    else if (bestValue >= beta) flag = TT_ALPHA;
    transpositionTable.set(hash, { score: bestValue, depth, flag });
    
    return bestValue;
}

// Listen for jobs from the orchestrator
self.onmessage = (e) => {
    const { jobId, board, depth, alpha, beta, playerIndex, turnCount, config, zobrist, zobristT } = e.data;
    
    if (e.data.type === 'init') {
        // Initialize the worker's state
        CONFIG = config;
        zobristTable = zobrist;
        zobristTurn = zobristT;
        // Clear the TT for a new turn
        transpositionTable.clear();
        return;
    }
    
    const score = alphaBeta(board, depth, alpha, beta, playerIndex, turnCount);

    // Send the result back, identified by its jobId
    self.postMessage({ jobId, score });
};