'use strict';

importScripts('game_logic.js');

let workers = [];
let jobResolvers = new Map();
let nextJobId = 0;
let isInitialized = false;

function terminateAllWorkers() {
    workers.forEach(w => w.terminate());
    workers = [];
    jobResolvers.clear();
    isInitialized = false;
}

function setupAndInitWorkers(numWorkers, config, zobrist, zobristT) {
    return new Promise(resolve => {
        if (isInitialized) {
            // If already initialized, just clear old jobs and resolve
            jobResolvers.clear();
            workers.forEach(worker => {
                worker.postMessage({
                    type: 'init',
                    config, zobrist, zobristT
                });
            });
            resolve();
            return;
        }

        let workersReady = 0;
        for (let i = 0; i < numWorkers; i++) {
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

            // Send initialization data once
            worker.postMessage({
                type: 'init',
                config, zobrist, zobristT
            });
            workersReady++;
        }
        isInitialized = true;
        resolve();
    });
}

function dispatchJob(jobData) {
    return new Promise((resolve) => {
        const jobId = nextJobId++;
        jobResolvers.set(jobId, resolve);
        const workerIndex = jobId % workers.length;
        // KEY CHANGE: The transposition table (`tt`) is no longer sent with the job.
        workers[workerIndex].postMessage({ ...jobData, jobId });
    });
}

async function findBestMove(board, currentPlayerIndex, turnCount) {
    let bestMoveSoFar = null;
    let bestScoreSoFar = -Infinity;
    
    const playerColor = CONFIG.COLORS[currentPlayerIndex];
    const rootMoves = getOrderedMoves(board, turnCount, playerColor);
    
    if (rootMoves.length === 0) {
        return { bestMove: null };
    }
    
    // As a fallback, always have a move ready
    bestMoveSoFar = rootMoves[0].move;

    // Iterative Deepening
    for (let depth = 1; depth <= CONFIG.AI_MAX_DEPTH; depth++) {
        const promises = rootMoves.map(moveObj => (async () => {
            const newBoard = applyMove(board, moveObj.move, playerColor);
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

        for (const result of results) {
            if (result.score > bestScoreForDepth) {
                bestScoreForDepth = result.score;
                bestMoveForDepth = result.move;
            }
        }
        
        // Save the best move from the completed depth level
        bestMoveSoFar = bestMoveForDepth;
        bestScoreSoFar = bestScoreForDepth;
        console.log(`Depth ${depth} complete. Best move:`, bestMoveSoFar, "Score:", bestScoreSoFar);
    }
    
    return { bestMove: bestMoveSoFar, score: bestScoreSoFar };
}

self.onmessage = async (e) => {
    const { board, currentPlayerIndex, turnCount, boardSize, config } = e.data;
    CONFIG = config; 
    CONFIG.boardSize = boardSize;
    
    initZobrist(boardSize);
    const numCores = navigator.hardwareConcurrency || 2;
    await setupAndInitWorkers(Math.max(1, numCores), CONFIG, zobristTable, zobristTurn);

    let bestResult = { bestMove: null };
    
    const rootMoves = getOrderedMoves(board, turnCount, CONFIG.COLORS[currentPlayerIndex]);
    if (rootMoves.length > 0) {
       bestResult.bestMove = rootMoves[0].move; // Ensure a move is always available
    } else {
       self.postMessage({ bestMove: null });
       return;
    }

    try {
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), CONFIG.AI_SEARCH_TIME_MS)
        );
        
        const searchPromise = findBestMove(board, currentPlayerIndex, turnCount);
        
        const finalResult = await Promise.race([searchPromise, timeoutPromise]);
        bestResult = finalResult;

    } catch (error) {
        console.warn(`AI search timed out. Using best move from last completed depth.`);
    } finally {
        self.postMessage(bestResult);
        terminateAllWorkers();
        self.close();
    }
};