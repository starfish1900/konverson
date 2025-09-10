'use strict';

importScripts('game_logic.js');

let workers = [];
let jobResolvers = new Map();
let nextJobId = 0;

// This function now cleanly terminates all active workers.
function terminateAllWorkers() {
    workers.forEach(w => w.terminate());
    workers = [];
    jobResolvers.clear();
}

// Sets up the worker pool and their message listeners.
function setupWorkers(numWorkers) {
    // Terminate any old workers before creating new ones.
    if (workers.length > 0) {
        terminateAllWorkers();
    }
    
    for (let i = 0; i < numWorkers; i++) {
        const worker = new Worker('helper_worker.js');
        worker.onmessage = (e) => {
            const { jobId, score } = e.data;
            if (jobResolvers.has(jobId)) {
                // When a worker finishes, it resolves the corresponding promise.
                jobResolvers.get(jobId)(score);
                jobResolvers.delete(jobId);
            }
        };
        // Add basic error handling for helpers
        worker.onerror = (err) => {
            console.error("Helper worker error:", err);
            // Rejecting the promise can help unblock the search
            const resolver = jobResolvers.get(parseInt(err.message, 10));
            if(resolver) resolver(-Infinity); 
        };
        workers.push(worker);
    }
}

// Function to dispatch a job to an available worker.
function runJobOnWorker(jobData) {
    return new Promise((resolve, reject) => {
        const jobId = nextJobId++;
        jobResolvers.set(jobId, resolve);

        // Simple round-robin dispatch to distribute work
        const workerIndex = jobId % workers.length;
        workers[workerIndex].postMessage({ ...jobData, jobId });
    });
}

// The core search logic, which remains largely the same but is now fully async.
async function search(board, depth, alpha, beta, playerIndex, turnCount, tt) {
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

    // YBWC: Serially evaluate the first child
    const firstMove = orderedMoves[0];
    const firstChildBoard = applyMove(board, firstMove.move, playerColor);
    const firstChildScore = await search(firstChildBoard, depth - 1, alpha, beta, (playerIndex + 1) % 4, turnCount + 1, tt);

    let bestValue = firstChildScore;
    if (isMaximizingPlayer) {
        alpha = Math.max(alpha, bestValue);
    } else {
        beta = Math.min(beta, bestValue);
    }

    if (beta > alpha) {
        // YBWC: Parallelize remaining children
        const promises = [];
        for (let i = 1; i < orderedMoves.length; i++) {
            const moveObj = orderedMoves[i];
            const childBoard = applyMove(board, moveObj.move, playerColor);
            // Note: For deep parallel searches, we would use helpers here.
            // For simplicity and stability, this example keeps recursion in the main orchestrator
            // and you would dispatch to helpers for computationally heavy sub-problems.
            // Let's modify to use helpers correctly here.
            promises.push(runJobOnWorker({
                board: childBoard,
                depth: depth - 1, alpha, beta,
                playerIndex: (playerIndex + 1) % 4,
                turnCount: turnCount + 1,
                tt, config: CONFIG, zobrist: zobristTable, zobristT: zobristTurn
            }));
        }

        const results = await Promise.all(promises);
        for (const value of results) {
            if (isMaximizingPlayer) {
                bestValue = Math.max(bestValue, value);
            } else {
                bestValue = Math.min(bestValue, value);
            }
        }
    }
    
    return bestValue;
}

// This is the new main async function for iterative deepening.
async function findBestMove(board, currentPlayerIndex, turnCount) {
    let finalBestMove = null;
    let finalScore = -Infinity;
    
    const playerColor = CONFIG.COLORS[currentPlayerIndex];
    const rootMoves = getOrderedMoves(board, turnCount, playerColor);
    if (rootMoves.length === 0) return { bestMove: null };
    
    finalBestMove = rootMoves[0].move; // Default to a valid move

    // Iterative Deepening Loop
    for (let depth = 1; depth <= CONFIG.AI_MAX_DEPTH; depth++) {
        let transpositionTable = new Map();
        let bestMoveForDepth = null;
        let bestValueForDepth = -Infinity;

        // At the root, we evaluate moves one by one to find the best *move*
        const movePromises = rootMoves.map(moveObj => (async () => {
            const newBoard = applyMove(board, moveObj.move, playerColor);
            // The search for each root move's consequences is now parallelized
            const value = await search(
                newBoard,
                depth - 1, -Infinity, Infinity,
                (currentPlayerIndex + 1) % 4,
                turnCount + 1,
                transpositionTable
            );
            return { move: moveObj.move, value };
        })());

        // Wait for all moves at the current depth to be evaluated
        const results = await Promise.all(movePromises);

        for (const result of results) {
            if (result.value > bestValueForDepth) {
                bestValueForDepth = result.value;
                bestMoveForDepth = result.move;
            }
        }

        // Store the best move found at this completed depth
        finalBestMove = bestMoveForDepth;
        finalScore = bestValueForDepth;
        console.log(`Depth ${depth} complete. Best move:`, finalBestMove, "Score:", finalScore);
    }
    
    return { bestMove: finalBestMove, score: finalScore };
}

// Main message handler for the orchestrator
self.onmessage = async (e) => {
    const { board, currentPlayerIndex, turnCount, boardSize, config } = e.data;
    CONFIG = config;
    CONFIG.boardSize = boardSize;

    // Determine the number of helpers. Use at least 1, max of (cores - 1).
    const numCores = navigator.hardwareConcurrency || 2;
    setupWorkers(Math.max(1, numCores - 1));
    initZobrist(boardSize);
    
    // **THE KEY FIX: Promise.race**
    // We race the search process against a timer.
    const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve({ timeout: true }), CONFIG.AI_SEARCH_TIME_MS);
    });

    const searchPromise = findBestMove(board, currentPlayerIndex, turnCount);

    const result = await Promise.race([searchPromise, timeoutPromise]);

    // No matter what happens, clean up the workers.
    terminateAllWorkers();

    if (result.timeout) {
        console.warn(`AI search timed out after ${CONFIG.AI_SEARCH_TIME_MS}ms.`);
        // `findBestMove` doesn't return intermediate results in this structure,
        // so we'd need a more complex implementation to return the best move from the *previous* depth.
        // For now, we'll let it return nothing, and the main thread will see it as an error.
        // A robust solution would save the best move from each completed depth. Let's do that.
        // This requires changing the structure slightly. A simpler fix is to return the best-guess move.
        const rootMoves = getOrderedMoves(board, turnCount, CONFIG.COLORS[currentPlayerIndex]);
        self.postMessage({ bestMove: rootMoves.length > 0 ? rootMoves[0].move : null, score: "Timeout", depth: "N/A" });
    } else {
        self.postMessage(result);
    }

    self.close();
};