'use strict';

// Import the shared logic
importScripts('game_logic.js');

let workers = [];
let jobQueue = [];
let workerStatus = []; // 'idle' or 'busy'
let jobResolvers = new Map();
let nextJobId = 0;
let startTime, timeUp;

// Initialize the worker pool
function initWorkers(numWorkers) {
    for (let i = 0; i < numWorkers; i++) {
        const worker = new Worker('helper_worker.js');
        worker.onmessage = (e) => {
            const { jobId, score } = e.data;
            if (jobResolvers.has(jobId)) {
                jobResolvers.get(jobId)(score); // Resolve the promise
                jobResolvers.delete(jobId);
            }
            workerStatus[i] = 'idle';
            // If there are pending jobs, run the next one
            if (jobQueue.length > 0) {
                const nextJob = jobQueue.shift();
                runJob(i, nextJob.jobData, nextJob.resolve);
            }
        };
        workers.push(worker);
        workerStatus.push('idle');
    }
}

// Function to send a job to a worker and return a promise for the result
function runJobOnWorker(jobData) {
    return new Promise((resolve) => {
        const idleWorkerIndex = workerStatus.findIndex(s => s === 'idle');
        if (idleWorkerIndex !== -1) {
            // An idle worker is available, run immediately
            runJob(idleWorkerIndex, jobData, resolve);
        } else {
            // All workers are busy, queue the job
            jobQueue.push({ jobData, resolve });
        }
    });
}

function runJob(workerIndex, jobData, resolve) {
    const jobId = nextJobId++;
    jobResolvers.set(jobId, resolve);
    workerStatus[workerIndex] = 'busy';
    workers[workerIndex].postMessage({ ...jobData, jobId });
}


// The parallel Alpha-Beta function implementing Young Brothers Wait Concept
async function parallelAlphaBeta(board, depth, alpha, beta, playerIndex, turnCount, tt) {
    if (depth === 0 || timeUp) {
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

    // --- YOUNG BROTHERS WAIT CONCEPT ---
    // 1. Serially evaluate the first child (the "eldest brother")
    const firstMove = orderedMoves[0];
    const firstChildBoard = applyMove(board, firstMove.move, playerColor);
    const firstChildScore = await runJobOnWorker({
        board: firstChildBoard,
        depth: depth - 1,
        alpha, beta,
        playerIndex: (playerIndex + 1) % 4,
        turnCount: turnCount + 1,
        tt,
        config: CONFIG,
        zobrist: zobristTable,
        zobristT: zobristTurn
    });

    let bestValue = firstChildScore;
    if (isMaximizingPlayer) {
        alpha = Math.max(alpha, bestValue);
    } else {
        beta = Math.min(beta, bestValue);
    }

    // 2. Parallelize the evaluation of the remaining children ("younger brothers")
    if (beta > alpha && orderedMoves.length > 1) {
        const youngerBrotherPromises = [];
        for (let i = 1; i < orderedMoves.length; i++) {
            const moveObj = orderedMoves[i];
            const childBoard = applyMove(board, moveObj.move, playerColor);
            
            youngerBrotherPromises.push(runJobOnWorker({
                board: childBoard,
                depth: depth - 1,
                alpha, beta, // Use the updated alpha/beta from the first child
                playerIndex: (playerIndex + 1) % 4,
                turnCount: turnCount + 1,
                tt,
                config: CONFIG,
                zobrist: zobristTable,
                zobristT: zobristTurn
            }));
        }

        const results = await Promise.all(youngerBrotherPromises);

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


// Main message handler for the orchestrator
self.onmessage = async (e) => {
    const { board, currentPlayerIndex, turnCount, boardSize, config } = e.data;
    CONFIG = config;
    CONFIG.boardSize = boardSize;

    const numCores = navigator.hardwareConcurrency || 2;
    initWorkers(Math.max(1, numCores - 1)); // Use N-1 cores for helpers
    initZobrist(boardSize);
    
    startTime = Date.now();
    timeUp = false;
    let finalBestMove = null, finalScore = -Infinity, finalDepth = 0;

    const playerColor = CONFIG.COLORS[currentPlayerIndex];
    const rootMoves = getOrderedMoves(board, turnCount, playerColor);
    if(rootMoves.length === 0) {
        self.postMessage({ bestMove: null });
        return;
    }

    // Iterative Deepening
    for (let depth = 1; depth <= CONFIG.AI_MAX_DEPTH; depth++) {
        let transpositionTable = new Map();
        let bestMoveForDepth = null;
        let bestValueForDepth = -Infinity;

        // At the root, we evaluate moves one by one to find the best *move*
        for (const moveObj of rootMoves) {
            const newBoard = applyMove(board, moveObj.move, playerColor);
            const value = await parallelAlphaBeta(
                newBoard,
                depth - 1,
                -Infinity,
                Infinity,
                (currentPlayerIndex + 1) % 4,
                turnCount + 1,
                transpositionTable
            );
            
            if (value > bestValueForDepth) {
                bestValueForDepth = value;
                bestMoveForDepth = moveObj.move;
            }

            if (Date.now() - startTime > CONFIG.AI_SEARCH_TIME_MS) {
                timeUp = true;
                break;
            }
        }

        if (timeUp) break;

        finalBestMove = bestMoveForDepth;
        finalScore = bestValueForDepth;
        finalDepth = depth;
    }

    self.postMessage({ bestMove: finalBestMove, depth: finalDepth, score: finalScore });
    workers.forEach(w => w.terminate()); // Clean up workers
    self.close();
};