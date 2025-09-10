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
            // If there are genuinely no moves, post back, but this shouldn't happen on turn 2.
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

// This function now accepts rootMoves as a parameter to avoid calling getOrderedMoves again.
async function findBestMove(board, currentPlayerIndex, turnCount, rootMoves) {
    let bestMoveSoFar = rootMoves.length > 0 ? rootMoves[0].move : null;
    let bestScoreSoFar = -Infinity;

    // Iterative Deepening
    for (let depth = 1; depth <= CONFIG.AI_MAX_DEPTH; depth++) {
        const promises = rootMoves.map(moveObj => (async () => {
            const newBoard = applyMove(board, moveObj.move, CONFIG.COLORS[currentPlayerIndex]);
            const score = await dispatchJob({
                board: newBoard,
                depth: depth - 1,
                alpha: -Infinity,
                beta: Infinity,
                playerIndex: (currentPlayerIndex + 1) % 4,
                turnCount: turnCount + 1,
            });
            return { move: moveObj.move, score };
        })());

        const results = await Promise.all(promises);

        let bestMoveForDepth = bestMoveSoFar;
        let bestScoreForDepth = -Infinity;

        // Note: The logic here should account for the fact that the opponent is minimizing
        const isMaximizingPlayer = CONFIG.PLAYER_TEAMS[CONFIG.COLORS[currentPlayerIndex]] === 1;

        for (const result of results) {
            // The score from the helper is from the opponent's perspective. We need to flip it.
            const perspectiveScore = isMaximizingPlayer ? result.score : -result.score;
            if (perspectiveScore > bestScoreForDepth) {
                bestScoreForDepth = perspectiveScore;
                bestMoveForDepth = result.move;
            }
        }

        bestMoveSoFar = bestMoveForDepth;
        bestScoreSoFar = bestScoreForDepth;
        console.log(`Depth ${depth} complete. Best move:`, bestMoveSoFar, "Score:", bestScoreSoFar);

        const bestMoveIndex = rootMoves.findIndex(m =>
            JSON.stringify(m.move) === JSON.stringify(bestMoveSoFar)
        );

        if (bestMoveIndex > 0) {
            const [pvMove] = rootMoves.splice(bestMoveIndex, 1);
            rootMoves.unshift(pvMove);
        }
    }

    return { bestMove: bestMoveSoFar, score: bestScoreSoFar };
}

function dispatchJob(jobData) {
    return new Promise((resolve) => {
        const jobId = nextJobId++;
        jobResolvers.set(jobId, resolve);
        const workerIndex = jobId % workers.length;
        workers[workerIndex].postMessage({ ...jobData, jobId });
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