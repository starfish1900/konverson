'use strict';

importScripts('game_logic.js');

let workers = [];
let jobResolvers = new Map();
let nextJobId = 0;

// The main message handler for the persistent worker
self.onmessage = async (e) => {
    const { type, board, currentPlayerIndex, turnCount, config } = e.data;

    if (type === 'findBestMove') {
        // --- THIS IS THE CRITICAL FIX ---
        // Ensure the global CONFIG for this worker is updated with every new move request.
        CONFIG = config;

        // Re-initialize Zobrist and clear TTs in helpers for the new turn
        initZobrist(CONFIG.boardSize);
        workers.forEach(w => w.postMessage({
            type: 'init',
            config: CONFIG,
            zobrist: zobristTable,
            zobristT: zobristTurn
        }));

        let bestResult = { bestMove: null };
        
        // Use the now-correct CONFIG to get the root moves
        const rootMoves = getOrderedMoves(board, turnCount, CONFIG.COLORS[currentPlayerIndex]);
        
        if (rootMoves.length > 0) {
            bestResult.bestMove = rootMoves[0].move;
        } else {
            // If there are genuinely no moves, post back.
            self.postMessage({ bestMove: null });
            return;
        }

        try {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), CONFIG.AI_SEARCH_TIME_MS)
            );

            const searchPromise = findBestMove(board, currentPlayerIndex, turnCount, rootMoves);

            const finalResult = await Promise.race([searchPromise, timeoutPromise]);
            bestResult = finalResult;

        } catch (error) {
            console.warn(`AI search timed out. Using best move from the last completed depth.`);
        } finally {
            // As a persistent worker, it does NOT terminate itself. It just sends the result.
            self.postMessage(bestResult);
        }
    }
};

/**
 * --- NEW: findBestMove with Aspiration Windows ---
 * This function now uses the score from the previous depth (lastScore) to create a narrow
 * search window (alpha, beta). If the search "fails" by returning a score outside this
 * window, it re-searches with a wider window. This is more efficient than always
 * searching with (-Infinity, +Infinity).
 */
async function findBestMove(board, currentPlayerIndex, turnCount, rootMoves) {
    let bestMoveSoFar = rootMoves.length > 0 ? rootMoves[0].move : null;
    let bestScoreSoFar = -Infinity;
    
    // --- ASPIRATION WINDOWS SETUP ---
    let lastScore = 0; // Use score from previous depth as the center for the window.
    const ASPIRATION_WINDOW_DELTA = 50; // A tunable value for the window's width.

    // Iterative Deepening Loop
    for (let depth = 1; depth <= CONFIG.AI_MAX_DEPTH; depth++) {
        let alpha = lastScore - ASPIRATION_WINDOW_DELTA;
        let beta = lastScore + ASPIRATION_WINDOW_DELTA;

        // Loop for re-searching if the score falls outside the aspiration window.
        while (true) { 
            const promises = rootMoves.map(moveObj => (async () => {
                const newBoard = applyMove(board, moveObj.move, CONFIG.COLORS[currentPlayerIndex]);
                // Dispatch job for the opponent. The alpha/beta window is flipped and negated for a NegaMax search.
                const score = await dispatchJob({
                    board: newBoard,
                    depth: depth - 1,
                    alpha: -beta, 
                    beta: -alpha, 
                    playerIndex: (currentPlayerIndex + 1) % 4,
                    turnCount: turnCount + 1,
                });
                // The returned score is from the opponent's view. Negate it for our perspective.
                return { move: moveObj.move, score: -score };
            })());

            const results = await Promise.all(promises);

            let bestMoveForDepth = bestMoveSoFar;
            let bestScoreForDepth = -Infinity;

            for (const result of results) {
                if (result.score > bestScoreForDepth) {
                    bestScoreForDepth = result.score;
                    bestMoveForDepth = result.move;
                }
            }

            // --- CHECK ASPIRATION WINDOW RESULT ---
            if (bestScoreForDepth <= alpha) { // Fail low: score was worse than expected.
                console.log(`Depth ${depth} failed low (${bestScoreForDepth} <= ${alpha}). Re-searching.`);
                alpha = -Infinity; // Widen window downwards and search again.
                continue;
            }

            if (bestScoreForDepth >= beta) { // Fail high: score was better than expected.
                console.log(`Depth ${depth} failed high (${bestScoreForDepth} >= ${beta}). Re-searching.`);
                beta = Infinity; // Widen window upwards and search again.
                continue;
            }
            
            // --- SUCCESS: Score was within the window ---
            bestMoveSoFar = bestMoveForDepth;
            bestScoreSoFar = bestScoreForDepth;
            lastScore = bestScoreForDepth; // Center the next window around this score.
            console.log(`Depth ${depth} complete. Best move:`, bestMoveSoFar, "Score:", bestScoreSoFar);

            // Move the best move (Principal Variation) to the front for the next iteration.
            const bestMoveIndex = rootMoves.findIndex(m =>
                JSON.stringify(m.move) === JSON.stringify(bestMoveSoFar)
            );
            if (bestMoveIndex > 0) {
                const [pvMove] = rootMoves.splice(bestMoveIndex, 1);
                rootMoves.unshift(pvMove);
            }

            break; // Exit the while loop and proceed to the next depth.
        }
    }

    return { bestMove: bestMoveSoFar, score: bestScoreSoFar };
}

function dispatchJob(jobData) {
    return new Promise((resolve) => {
        const jobId = nextJobId++;
        jobResolvers.set(jobId, resolve);
        const workerIndex = jobId % workers.length;
        // Pass the config with every job to ensure helpers are up-to-date
        workers[workerIndex].postMessage({ ...jobData, config: CONFIG });
    });
}

// Initial setup runs once when the orchestrator worker is first created.
function initialSetup() {
    const numCores = navigator.hardwareConcurrency || 2;
    for (let i = 0; i < numCores; i++) {
        const worker = new Worker('helper_worker.js');
        worker.onmessage = (e) => {
            const { jobId, score } = e.data;
            if (jobResolvers.has(jobId)) {
                jobResolvers.get(jobId)(score);
                jobResolvers.delete(jobId);
            }
        };
        worker.onerror = (err) => console.error("Helper worker error:", err);
        workers.push(worker);
    }
}

initialSetup();