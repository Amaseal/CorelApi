import { randomUUID } from 'crypto';
import { NestPart, runNesting } from './nest';
import { NestingError, PackResult, PassBudget, SheetSize } from './types';

export type JobStatus = 'pending' | 'running' | 'done' | 'error';

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
  error: string | null;
  cancelled: boolean;
}

const jobs = new Map<string, Job>();
const JOB_TTL_MS = 30 * 60 * 1000;

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
    error: null,
    cancelled: false,
  };
  jobs.set(id, job);

  const startedAt = Date.now();
  runNesting(
    config.sheet,
    config.gap,
    config.parts,
    config.budget,
    (iterationsTried, best) => {
      job.iterationsTried = iterationsTried;
      job.best = best;
      job.elapsedMs = Date.now() - startedAt;
    },
    () => job.cancelled,
  )
    .then((result) => {
      job.best = result;
      job.status = 'done';
    })
    .catch((e) => {
      job.status = 'error';
      job.error = e instanceof NestingError ? e.message : String(e);
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
