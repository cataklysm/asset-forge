// A stand-in for the backup check worker that holds the copy open in one long synchronous SQLite call, which
// `worker.terminate()` cannot interrupt. Used to test that a stopped check answers at once.
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const sqlite = new Database(workerData.path, { fileMustExist: true });
sqlite
  .prepare('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 40000000) SELECT count(*) FROM c')
  .get();
sqlite.close();
parentPort.postMessage(null);
