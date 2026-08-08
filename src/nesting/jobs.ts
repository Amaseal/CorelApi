import { randomUUID } from 'crypto';
import { NestPart, runNesting } from './nest';
import { NestingError, PackResult, PassBudget, SheetSize } from './types';

export type JobStatus = 'pending' | 'running' | 'done' | 'error';

function describeFootprints(result: PackResult): string {
  return result.sheetFootprints.map((f) => `${f.width.toFixed(0)}x${f.height.toFixed(0)}mm`).join(', ');
}

export interface NestJobConfig {
  sheet: SheetSize;
  gap: number;
  budget: PassBudget;
  parts: NestPart[];
}

interface Job {
  id: string;
  status: JobStatus;
  createdAt: number;
  finishedAt: number | null;
  elapsedMs: number;
  iterationsTried: number;
  best: PackResult | null;
  // The most recent attempt's own result, separate from `best` — lets a caller compare "what did
  // the last try actually get" against "what's the best so far" to confirm the search is really
  // keeping the best one, not just reporting whatever ran most recently.
  lastAttempt: PackResult | null;
  error: string | null;
  cancelled: boolean;
}

const jobs = new Map<string, Job>();
const JOB_TTL_MS = 30 * 60 * 1000;

// Progress fires every few placed parts (see packer.ts's yield points) — that can be very
// frequent for a large job, so progress lines are throttled to avoid flooding the logs.
const PROGRESS_LOG_INTERVAL_MS = 2000;

export function createJob(config: NestJobConfig): string {
  const id = randomUUID();
  const job: Job = {
    id,
    status: 'running',
    createdAt: Date.now(),
    finishedAt: null,
    elapsedMs: 0,
    iterationsTried: 0,
    best: null,
    lastAttempt: null,
    error: null,
    cancelled: false,
  };
  jobs.set(id, job);

  const partCount = config.parts.reduce((sum, p) => sum + p.quantity, 0);
  const pointCount = config.parts.reduce((sum, p) => sum + p.outline.length * p.quantity, 0);
  console.log(
    `[nest ${id}] start: ${partCount} part(s), ~${pointCount} outline point(s), ` +
    `sheet ${config.sheet.width}x${config.sheet.height}mm, gap ${config.gap}mm, ` +
    `budget ${config.budget.timeBudgetSec ? config.budget.timeBudgetSec + 's' : config.budget.maxIterations + ' iterations'}`
  );

  const startedAt = Date.now();
  let lastProgressLogAt = 0;

  runNesting(
    config.sheet,
    config.gap,
    config.parts,
    config.budget,
    (iterationsTried, current, best) => {
      job.iterationsTried = iterationsTried;
      job.best = best;
      job.lastAttempt = current;
      job.elapsedMs = Date.now() - startedAt;

      const now = Date.now();
      if (now - lastProgressLogAt >= PROGRESS_LOG_INTERVAL_MS) {
        lastProgressLogAt = now;
        const currentInfo = current ? `this try: ${current.sheetsUsed} sheet(s) (${describeFootprints(current)})` : 'this try: no fit';
        const bestInfo = best ? `best so far: ${best.sheetsUsed} sheet(s) (${describeFootprints(best)}), ${best.utilizationPct.toFixed(1)}% used` : 'no valid arrangement yet';
        console.log(`[nest ${id}] progress: ${iterationsTried} attempt(s), ${(job.elapsedMs / 1000).toFixed(1)}s elapsed, ${currentInfo}, ${bestInfo}`);
      }
    },
    () => job.cancelled,
  )
    .then((result) => {
      job.best = result;
      job.status = 'done';
      console.log(
        `[nest ${id}] done: ${result.sheetsUsed} sheet(s) (${describeFootprints(result)}), ` +
        `${result.utilizationPct.toFixed(1)}% utilization, ${job.iterationsTried} attempt(s), ${(job.elapsedMs / 1000).toFixed(1)}s`
      );
    })
    .catch((e) => {
      job.status = 'error';
      job.error = e instanceof NestingError ? e.message : String(e);
      console.error(`[nest ${id}] failed after ${job.iterationsTried} attempt(s):`, e);
    })
    .finally(() => {
      job.finishedAt = Date.now();
      job.elapsedMs = job.finishedAt - startedAt;
    });

  return id;
}

export function getJob(id: string) {
  return jobs.get(id);
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  console.log(`[nest ${id}] cancel requested at ${job.iterationsTried} attempt(s)`);
  job.cancelled = true;
  return true;
}

// Sweep finished jobs periodically — results are ephemeral, not persisted.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt !== null && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 5 * 60 * 1000);
sweep.unref();
