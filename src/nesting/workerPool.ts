// Runs packAttempt calls on a pool of worker_threads instead of the main event loop. Each
// generation in nest.ts's GA evaluates POPULATION_SIZE independent individuals — independent
// meaning nothing about scoring one depends on any other — so they're a natural fit for spreading
// across cores instead of running one after another on Node's single thread. The server runs on a
// dedicated container that's otherwise idle between jobs, so there's no reason to leave the rest
// of the cores unused.
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { NestingError, PackResult, PartInstance, SheetSize } from './types';

interface PoolWorker {
  worker: Worker;
  busy: boolean;
  // The job currently in flight on this worker, if any — needed so a crash mid-job (see
  // handleWorkerDeath below) can reject that SPECIFIC pending promise instead of leaving it
  // hanging forever (which, awaited via Promise.all across a whole GA generation, would hang all
  // of runNesting, not just the one lost attempt).
  jobId: number | null;
}

interface QueuedJob {
  id: number;
  sheet: SheetSize;
  gap: number;
  instances: PartInstance[];
}

interface PendingEntry {
  resolve: (r: PackResult) => void;
  reject: (e: unknown) => void;
}

let workers: PoolWorker[] = [];
let nextId = 1;
const pending = new Map<number, PendingEntry>();
const queue: QueuedJob[] = [];

// Reserve one core for the main thread (Express, DB queries, JSON parsing of large payloads) so a
// big nesting job can't starve request handling entirely. Everything else goes to workers.
// Overridable via NESTING_WORKERS — e.g. to deliberately under-provision on a box that runs other
// things too, or to try pushing past cpus()-1 on a box dedicated to this API.
function defaultPoolSize(): number {
  const envSize = Number(process.env.NESTING_WORKERS);
  if (Number.isInteger(envSize) && envSize > 0) return envSize;
  return Math.max(1, os.cpus().length - 1);
}

// __filename retains its real .ts path under tsx (dev) and is the compiled .js path under
// `node dist/index.js` (prod). In prod, worker.js is already plain JS and can be the Worker's
// entry point directly. In dev, a worker_threads Worker resolves its OWN entry module
// independently of whatever loader hooks the PARENT thread registered — tsx's ESM loader flag
// does not carry over to a freshly spawned worker's module resolution (confirmed empirically:
// passing `--import tsx` via execArgv still threw ERR_UNKNOWN_FILE_EXTENSION for a .ts entry).
// worker.bootstrap.cjs sidesteps that by registering tsx's CommonJS require() hook FROM INSIDE
// the new worker thread, before requiring worker.ts — see that file's own comment.
function workerEntryPath(): string {
  const isDevTsSource = __filename.endsWith('.ts');
  return path.join(__dirname, isDevTsSource ? 'worker.bootstrap.cjs' : 'worker.js');
}

function pump(): void {
  if (queue.length === 0) return;
  for (const pw of workers) {
    if (pw.busy) continue;
    const job = queue.shift();
    if (!job) return;
    pw.busy = true;
    pw.jobId = job.id;
    // Only ref'd while it actually has work in flight (see the .unref() note in spawnWorker) —
    // this is what lets a caller with no other active handle (a one-off script, a test) still
    // block on a pending result instead of the process exiting out from under it.
    pw.worker.ref();
    pw.worker.postMessage(job);
  }
}

// Creates one pool worker, wired up to: hand back results/errors for the job it's currently
// running, and — if it crashes mid-job — reject that job and replace itself so pool capacity
// doesn't quietly shrink after a crash. Used both for the pool's initial fill and for replacing a
// worker that died.
function spawnWorker(entry: string): void {
  const worker = new Worker(entry);
  const pw: PoolWorker = { worker, busy: false, jobId: null };

  // True once this worker has been torn down — guards against 'error' and the 'exit' that
  // follows it both trying to reject/replace the same slot.
  let removed = false;

  const handleWorkerDeath = (err: unknown) => {
    if (removed) return;
    removed = true;
    workers = workers.filter((w) => w !== pw);
    if (pw.jobId !== null) {
      const jobEntry = pending.get(pw.jobId);
      pending.delete(pw.jobId);
      if (jobEntry) jobEntry.reject(err instanceof Error ? err : new Error(`Nesting worker died: ${String(err)}`));
    }
    spawnWorker(entry);
    pump();
  };

  worker.on('message', (msg: { id: number; result?: PackResult; error?: { message: string; isNestingError: boolean } }) => {
    const jobEntry = pending.get(msg.id);
    pending.delete(msg.id);
    pw.busy = false;
    pw.jobId = null;
    pw.worker.unref();
    if (jobEntry) {
      if (msg.error) {
        jobEntry.reject(msg.error.isNestingError ? new NestingError(msg.error.message) : new Error(msg.error.message));
      } else if (msg.result) {
        jobEntry.resolve(msg.result);
      }
    }
    pump();
  });

  worker.on('error', (err) => {
    console.error('[nesting worker] uncaught error, replacing worker', err);
    handleWorkerDeath(err);
  });

  worker.on('exit', (code) => {
    if (removed || code === 0) return; // 0 = normal shutdown (e.g. process exiting), not a crash
    console.error(`[nesting worker] exited unexpectedly with code ${code}, replacing worker`);
    handleWorkerDeath(new Error(`Nesting worker exited with code ${code}`));
  });

  // Starts unref'd (idle, no work yet) — ref'd only while it actually has a job in flight (see
  // pump() above). Without this, an idle pool would keep any process alive forever just by
  // existing — including a one-off script or a test run that finished all its actual work and
  // expects to exit.
  worker.unref();

  workers.push(pw);
}

export function initWorkerPool(size: number = defaultPoolSize()): void {
  if (workers.length > 0) return;
  const entry = workerEntryPath();
  for (let i = 0; i < size; i++) spawnWorker(entry);
  console.log(`[nesting] worker pool started: ${size} worker(s) (${os.cpus().length} CPU(s) available)`);
}

export function runPackAttempt(sheet: SheetSize, gap: number, instances: PartInstance[]): Promise<PackResult> {
  if (workers.length === 0) initWorkerPool();
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    queue.push({ id, sheet, gap, instances });
    pump();
  });
}
