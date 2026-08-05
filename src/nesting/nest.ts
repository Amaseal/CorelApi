import { Polygon, netArea } from './geometry';
import { packAttempt } from './packer';
import { NestingError, PackResult, PartInstance, PassBudget, RotationMode, SheetSize } from './types';

export interface NestPart {
  partId: string;
  outline: Polygon;
  holes: Polygon[];
  rotationMode: RotationMode;
  quantity: number;
}

function expandInstances(parts: NestPart[]): PartInstance[] {
  const instances: PartInstance[] = [];
  for (const part of parts) {
    for (let i = 0; i < part.quantity; i++) {
      instances.push({
        instanceId: `${part.partId}#${i}`,
        partId: part.partId,
        outline: part.outline,
        holes: part.holes,
        rotationMode: part.rotationMode,
      });
    }
  }
  return instances;
}

function isBetter(a: PackResult, b: PackResult): boolean {
  if (a.sheetsUsed !== b.sheetsUsed) return a.sheetsUsed < b.sheetsUsed;
  return a.utilizationPct > b.utilizationPct;
}

function shuffled<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Runs repeated bottom-left-fill packing attempts (mirrors e-cut's "try for N seconds / N times,
// keep the best" passes), yielding between attempts so job status can be polled and cancelled.
export async function runNesting(
  sheet: SheetSize,
  gap: number,
  parts: NestPart[],
  budget: PassBudget,
  onProgress: (iterationsTried: number, best: PackResult | null) => void,
  isCancelled: () => boolean,
): Promise<PackResult> {
  const baseInstances = expandInstances(parts);
  if (baseInstances.length === 0) throw new NestingError('No parts to nest');

  const maxIterations = budget.maxIterations ?? Infinity;
  const timeBudgetMs = budget.timeBudgetSec ? budget.timeBudgetSec * 1000 : Infinity;
  if (!Number.isFinite(maxIterations) && !Number.isFinite(timeBudgetMs)) {
    throw new NestingError('A time or iteration budget is required');
  }

  const start = Date.now();
  let best: PackResult | null = null;
  let iterations = 0;

  // First pass is deterministic (largest part first — a solid baseline heuristic).
  // Subsequent passes randomize placement order to explore other arrangements.
  let order = [...baseInstances].sort((a, b) => netArea(b.outline, b.holes) - netArea(a.outline, a.holes));

  while (iterations < maxIterations && Date.now() - start < timeBudgetMs && !isCancelled()) {
    try {
      const result = packAttempt(sheet, gap, order);
      if (!best || isBetter(result, best)) best = result;
    } catch (e) {
      if (!(e instanceof NestingError)) throw e;
      // This ordering couldn't even fit something on an empty sheet — a fundamental sizing
      // problem, not a bad arrangement, so surface it immediately rather than burning the budget.
      if (!best) throw e;
    }

    iterations++;
    onProgress(iterations, best);

    if (iterations >= maxIterations || Date.now() - start >= timeBudgetMs || isCancelled()) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
    order = shuffled(baseInstances);
  }

  if (!best) throw new NestingError('Nesting failed: no arrangement found');
  return best;
}
