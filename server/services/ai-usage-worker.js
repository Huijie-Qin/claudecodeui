import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';

import { runAiUsageWindow } from './ai-usage-batches.js';

// The parent migrates the resolved database before starting this worker. Never
// import database/db.js here: importing it opens/migrates the application DB.
const database = new Database(workerData.databasePath, { fileMustExist: true, timeout: 1000 });
database.pragma('foreign_keys = ON');
let stopping = false;
parentPort.on('message', (message) => { if (message.type === 'stop') stopping = true; });
try {
  const result = await runAiUsageWindow({ database, config: workerData.config, shouldStop: () => stopping });
  parentPort.postMessage({ type: 'result', result });
} catch (error) {
  parentPort.postMessage({ type: 'error', error: error.message });
} finally {
  database.close();
  parentPort.close();
}
