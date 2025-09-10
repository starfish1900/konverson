'use strict';

// Import the shared logic
importScripts('game_logic.js');

const TT_EXACT = 0, TT_ALPHA = 1, TT_BETA = 2;
// The TT is a persistent variable inside the worker.
let transpositionTable = new Map();

// --- NEW: HISTORY HEURISTIC TABLE ---
// Stores scores for individual placements that have proven effective.
let historyTable = [];

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

    // --- NULL-MOVE PRUNING LOGIC ---
    const R_NMP = 3; // Depth reduction factor for Null-Move Pruning
    if (depth >= R_NMP) {
        const nextPlayerIndex = (playerIndex + 1) % 4;
        // Note: The original implementation had a bug passing `alpha, beta` here.
        // For a null move, the side to move flips, so the bounds for the recursive call must also flip and be negated.
        const nullScore = -alphaBeta(board, depth - 1 - R_NMP, -beta, -alpha, nextPlayerIndex, turnCount + 1);

        if (isMaximizingPlayer && nullScore >= beta) {
            return beta; // Prune
        }
        if (!isMaximizingPlayer && nullScore <= alpha) {
            return alpha; // Prune
        }
    }
    // --- END NULL-MOVE PRUNING ---

    const orderedMoves = getOrderedMoves(board, turnCount, playerColor);
    
    // --- APPLY HISTORY HEURISTIC FOR MOVE ORDERING ---
    // Before searching, we enhance the sorting with our history scores.
    for (const moveObj of orderedMoves) {
        let historyScore = 0;
        for (const placement of moveObj.move) {
            historyScore += historyTable[placement.r][placement.c];
        }
        moveObj.score += historyScore; // Add history bonus to the static score
    }
    orderedMoves.sort((a, b) => b.score - a.score); // Re-sort with the new scores

    if (orderedMoves.length === 0) {
        return evaluate(board);
    }

    let bestValue = isMaximizingPlayer ? -Infinity : Infinity;
    let moveIndex = 0; // --- Counter for Late Move Reductions ---

    for (const moveObj of orderedMoves) {
        const newBoard = applyMove(board, moveObj.move, playerColor);
        const nextPlayerIndex = (playerIndex + 1) % 4;
        
        let value;
        // --- LATE MOVE REDUCTIONS (LMR) LOGIC ---
        const R_LMR = 1; // Reduction factor
        // Conditions: Don't reduce at low depths, and don't reduce the first few "best" moves.
        if (depth >= 3 && moveIndex >= 2) {
            // Search with a reduced depth first
            value = alphaBeta(newBoard, depth - 1 - R_LMR, alpha, beta, nextPlayerIndex, turnCount + 1);

            // If the reduced search looks promising, re-search at full depth
            if ((isMaximizingPlayer && value > alpha) || (!isMaximizingPlayer && value < beta)) {
                 value = alphaBeta(newBoard, depth - 1, alpha, beta, nextPlayerIndex, turnCount + 1);
            }
        } else {
            // Normal full-depth search for the first few moves
            value = alphaBeta(newBoard, depth - 1, alpha, beta, nextPlayerIndex, turnCount + 1);
        }
        // --- END LMR LOGIC ---

        moveIndex++; // Increment move counter

        if (isMaximizingPlayer) {
            bestValue = Math.max(bestValue, value);
            alpha = Math.max(alpha, bestValue);
        } else {
            bestValue = Math.min(bestValue, value);
            beta = Math.min(beta, bestValue);
        }

        if (beta <= alpha) {
            // --- UPDATE HISTORY TABLE ON CUTOFF ---
            // This move was good, so we reward its placements.
            for (const placement of moveObj.move) {
                 historyTable[placement.r][placement.c] += depth * depth;
            }
            break;
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
    CONFIG = config; // Make sure config is fresh for each job

    // --- INITIALIZE HISTORY TABLE FOR EACH NEW SEARCH ---
    if (!historyTable.length || historyTable.length !== CONFIG.boardSize) {
        historyTable = Array(CONFIG.boardSize).fill(0).map(() => Array(CONFIG.boardSize).fill(0));
    }

    const score = alphaBeta(board, depth, alpha, beta, playerIndex, turnCount);

    self.postMessage({ jobId, score });
};