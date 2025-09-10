'use strict';

// Import the shared logic
importScripts('game_logic.js');

const TT_EXACT = 0, TT_ALPHA = 1, TT_BETA = 2;
// KEY CHANGE: The TT is now a persistent variable inside the worker.
// It is created once and reused for all subsequent jobs.
let transpositionTable = new Map();

// The serial alpha-beta search function, unchanged
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
        return evaluate(board);
    }
    
    const winInfo = checkWinCondition(board);
    if (winInfo) return evaluate(board);

    const playerColor = CONFIG.COLORS[playerIndex];
    const isMaximizingPlayer = CONFIG.PLAYER_TEAMS[playerColor] === 1;
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
    // KEY CHANGE: `tt` is NO LONGER passed in the message.
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