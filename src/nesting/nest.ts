import { Polygon, boundingBox, minAreaBoundingRectAngle, netArea } from './geometry';
import { packAttempt } from './packer';
import { NestingError, PackResult, PartInstance, PassBudget, RotationMode, SheetSize } from './types';

export interface NestPart {
  partId: string;
  outline: Polygon;
  holes: Polygon[];
  rotationMode: RotationMode;
  quantity: number;
}

// Every 15 degrees for 'free' — matches the resolution the plugin exposes; mutation can still
// only ever land on one of these, same as before, just chosen once per part per attempt instead
// of every angle being exhaustively tried inside every attempt.
const FREE_ROTATION_STEP_DEG = 15;

// One angle per part, computed once (cheap: convex hull + O(n) calipers, no NFP, no search) —
// the rotation that minimizes the part's OWN bounding box. Confirmed against a live comparison:
// e-cut's "Fix angle: Auto" setting behaves like this, and it measurably outperformed random
// rotation search within any practical time budget in our own testing (searching freely across
// 24 angles per part explodes the combined search space far faster than a GA can explore it).
// Never used for 'locked' parts — that mode is an explicit user constraint (print orientation,
// fabric grain), not something to auto-rotate away from.
function computeAutoAngles(parts: NestPart[]): Map<string, number> {
  const angles = new Map<string, number>();
  for (const part of parts) angles.set(part.partId, minAreaBoundingRectAngle(part.outline));
  return angles;
}

// Snaps the (continuous) auto angle to whatever this mode actually allows — 'step90' has exactly
//4 legal values, so the raw auto angle is never valid there as-is.
function snappedAutoAngle(mode: RotationMode, autoAngle: number): number {
  if (mode === 'locked') return 0;
  if (mode === 'step90') return (Math.round(autoAngle / 90) * 90) % 360;
  return autoAngle;
}

// Mostly exploits the auto angle (or a small perturbation of it), with some full-random
// exploration mixed in so the search isn't entirely dependent on the heuristic being right.
function randomLegalRotation(mode: RotationMode, autoAngle: number): number {
  if (mode === 'locked') return 0;

  if (mode === 'step90') {
    if (Math.random() < 0.6) return snappedAutoAngle(mode, autoAngle);
    return [0, 90, 180, 270][Math.floor(Math.random() * 4)];
  }

  const steps = Math.floor(360 / FREE_ROTATION_STEP_DEG);
  const r = Math.random();
  if (r < 0.4) return autoAngle;
  if (r < 0.7) {
    const deltaSteps = Math.floor(Math.random() * 5) - 2; // -2..+2 steps, i.e. -30..+30 degrees
    let a = (autoAngle + deltaSteps * FREE_ROTATION_STEP_DEG) % 360;
    if (a < 0) a += 360;
    return a;
  }
  return Math.floor(Math.random() * steps) * FREE_ROTATION_STEP_DEG;
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
        rotationDeg: 0, // placeholder — each population individual assigns its own below
      });
    }
  }
  return instances;
}

// Fewer sheets wins outright. Otherwise, prefer whichever arrangement actually consumed less
// material — total footprint HEIGHT summed across sheets (not utilizationPct: for a fixed sheet
// count, usedArea and the configured sheet size are both constant across every attempt, so that
// percentage can never change no matter how much tighter one arrangement is than another). Height,
// not area, because sheet width is a hard constraint (roll width) while height/length is the
// actual cost driver — mirrors e-cut's own framing (same width, shorter length = better).
function isBetter(a: PackResult, b: PackResult): boolean {
  if (a.sheetsUsed !== b.sheetsUsed) return a.sheetsUsed < b.sheetsUsed;
  const heightA = a.sheetFootprints.reduce((sum, f) => sum + f.height, 0);
  const heightB = b.sheetFootprints.reduce((sum, f) => sum + f.height, 0);
  return heightA < heightB;
}

// Single numeric score matching isBetter()'s priority (sheets dominate, height is the
// tiebreaker), needed for population sorting/selection rather than pairwise comparison.
function fitnessOf(result: PackResult): number {
  const height = result.sheetFootprints.reduce((sum, f) => sum + f.height, 0);
  return result.sheetsUsed * 1_000_000 + height;
}

function shuffled<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Sized for the packer's per-attempt cost, which is no longer cheap: since packAttempt now runs a
// full compaction pass after the greedy placement (see packer.ts's compactSheet), one attempt
// costs several seconds, not ~1s. A population of 10 needs 10 evaluations just to complete a
// single generation — measured to blow almost an entire 60s budget on ONE ungoverned population,
// meaning crossover/selection/elitism never fired even once (confirmed by a real run where the
// best result was byte-for-byte identical across all 9 attempts that fit in the budget). Smaller
// so several real generations — where the GA's actual value comes from — fit in a realistic budget.
const POPULATION_SIZE = 6;
// Order mutation now relocates a part to ANY position (see mutate() below) instead of swapping
// with a neighbor — a much stronger move. At the old 0.1 rate that's ~1.7 of 17 parts randomly
// relocated per individual per generation, which measured as too disruptive for good structure to
// survive from one generation to the next (results got WORSE, not better, after making the move
// operator stronger without lowering its rate to compensate). Kept low so mutation reads as
// occasional, surgical jumps rather than wholesale reshuffling.
const ORDER_MUTATION_RATE = 0.03;
const ROTATION_MUTATION_RATE = 0.1;
const RANDOM_IMMIGRANTS_PER_GEN = 2;

// Rank-based weighted selection favoring fitter individuals: `sortedPop` must already be sorted
// best-first. Best gets weight POPULATION_SIZE, worst gets weight 1 — simpler than SVGnest's exact
// exponential curve but the same idea (fitter individuals reproduce more often, not exclusively).
function selectParentIndex(popSize: number): number {
  const totalWeight = (popSize * (popSize + 1)) / 2;
  let r = Math.random() * totalWeight;
  for (let i = 0; i < popSize; i++) {
    const weight = popSize - i;
    if (r < weight) return i;
    r -= weight;
  }
  return popSize - 1;
}

// Order crossover (OX): each child inherits a prefix from one parent, then the remaining parts in
// the other parent's relative order — every part instance appears exactly once in each child.
// Rotation travels WITH each part gene (a child inherits whichever parent contributed that part's
// current rotation), so crossover recombines both order and rotation choices at once.
function crossover(parentA: PartInstance[], parentB: PartInstance[]): [PartInstance[], PartInstance[]] {
  const n = parentA.length;
  const cut = n < 2 ? n : 1 + Math.floor(Math.random() * (n - 1));

  const childA = parentA.slice(0, cut);
  const usedA = new Set(childA.map((p) => p.instanceId));
  for (const gene of parentB) {
    if (!usedA.has(gene.instanceId)) { childA.push(gene); usedA.add(gene.instanceId); }
  }

  const childB = parentB.slice(0, cut);
  const usedB = new Set(childB.map((p) => p.instanceId));
  for (const gene of parentA) {
    if (!usedB.has(gene.instanceId)) { childB.push(gene); usedB.add(gene.instanceId); }
  }

  return [childA, childB];
}

// Per-gene mutation: with ORDER_MUTATION_RATE probability, moves a part to a random new position
// in the sequence (NOT a swap with its neighbor — that can only ever shift an element by one slot
// per mutation event, which measured as far too weak to escape a structural local optimum within
// a practical number of generations; a real live run plateaued at attempt 33 of ~103 with zero
// improvement afterward). Independently, with ROTATION_MUTATION_RATE probability, rerolls a
// part's rotation to a new legal angle. Clones instances (rather than mutating shared objects)
// since the same PartInstance reference is shared across many individuals via crossover.
function mutate(individual: PartInstance[], autoAngles: Map<string, number>): PartInstance[] {
  const result = individual.map((p) => ({ ...p }));

  for (let i = 0; i < result.length; i++) {
    if (Math.random() < ORDER_MUTATION_RATE) {
      const item = result.splice(i, 1)[0];
      const j = Math.floor(Math.random() * result.length);
      result.splice(j, 0, item);
    }
  }

  for (let i = 0; i < result.length; i++) {
    if (Math.random() < ROTATION_MUTATION_RATE) {
      const autoAngle = autoAngles.get(result[i].partId) ?? 0;
      result[i] = { ...result[i], rotationDeg: randomLegalRotation(result[i].rotationMode, autoAngle) };
    }
  }

  return result;
}

function randomIndividual(baseInstances: PartInstance[], autoAngles: Map<string, number>): PartInstance[] {
  return shuffled(baseInstances).map((p) => ({ ...p, rotationDeg: randomLegalRotation(p.rotationMode, autoAngles.get(p.partId) ?? 0) }));
}

// Runs a genetic algorithm over part order + per-part rotation (mirrors SVGnest/Deepnest's
// approach: population, rank-weighted selection, order crossover, mutation, elitism) — each
// individual is evaluated with one cheap greedy packAttempt (no per-part rotation search, no
// beam branching; see packer.ts), so the search gets its quality from evolving many attempts
// rather than making any single attempt expensive.
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
  const autoAngles = computeAutoAngles(parts);

  const maxIterations = budget.maxIterations ?? Infinity;
  const timeBudgetMs = budget.timeBudgetSec ? budget.timeBudgetSec * 1000 : Infinity;
  if (!Number.isFinite(maxIterations) && !Number.isFinite(timeBudgetMs)) {
    throw new NestingError('A time or iteration budget is required');
  }

  const start = Date.now();
  const withinBudget = () => iterations < maxIterations && Date.now() - start < timeBudgetMs && !isCancelled();

  let best: PackResult | null = null;
  let iterations = 0;

  // "Adam" individual: deterministic largest-first order, each part at its auto angle — a solid,
  // cheap baseline (matches e-cut's own default behavior: "Fix angle: Auto" applied from the start,
  // not just as a mutation option).
  const adam = [...baseInstances]
    .sort((a, b) => netArea(b.outline, b.holes) - netArea(a.outline, a.holes))
    .map((p) => ({ ...p, rotationDeg: snappedAutoAngle(p.rotationMode, autoAngles.get(p.partId) ?? 0) }));

  // A second deterministic seed, sorted by bounding-box area (not true polygon area) with every
  // part left at rotation 0 (not the auto angle) — measured directly on a real job to land within
  // ~1% of e-cut's own benchmark on a single try, dramatically better than "adam" above. A random
  // shuffle of 17 parts essentially never rediscovers a specific ordering like this one on its own
  // within a realistic attempt budget, so it's seeded explicitly rather than left to chance.
  // Bbox-area ranking (vs. true polygon area) tends to front-load parts whose real footprint is
  // much smaller than their bounding box (e.g. long/thin or heavily notched shapes) earlier, which
  // apparently leaves better-shaped gaps for everything placed after them.
  const adamBboxUnrotated = [...baseInstances]
    .sort((a, b) => {
      const areaOf = (p: PartInstance) => boundingBox(p.outline).width * boundingBox(p.outline).height;
      return areaOf(b) - areaOf(a);
    })
    .map((p) => ({ ...p, rotationDeg: 0 }));

  let population: PartInstance[][] = [adam, adamBboxUnrotated];
  for (let i = population.length; i < POPULATION_SIZE; i++) population.push(randomIndividual(baseInstances, autoAngles));

  while (withinBudget()) {
    const scored: { individual: PartInstance[]; fitness: number }[] = [];

    for (const individual of population) {
      if (!withinBudget()) break;

      let result: PackResult | null = null;
      try {
        result = await packAttempt(sheet, gap, individual);
      } catch (e) {
        if (!(e instanceof NestingError)) throw e;
        // This specific order/rotation combination didn't fit — a bad individual, not a fatal
        // error; it just scores poorly below and selection naturally moves away from it.
      }

      iterations++;
      if (result && (!best || isBetter(result, best))) best = result;
      scored.push({ individual, fitness: result ? fitnessOf(result) : Number.MAX_SAFE_INTEGER });
      onProgress(iterations, best);

      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    if (!withinBudget() || scored.length === 0) break;

    scored.sort((a, b) => a.fitness - b.fitness);
    const sortedPop = scored.map((s) => s.individual);

    const nextGen: PartInstance[][] = [sortedPop[0]]; // elitism: best survives unchanged
    // A couple of fresh random individuals each generation ("immigration") — crossover and
    // mutation alone can only ever recombine genetic material already present in the population,
    // so once it converges toward similar individuals, there's nothing pushing back against a
    // local optimum. This was measured to plateau for 20+ attempts with zero improvement without
    // this — the earlier (pre-GA) hill-climbing search had an equivalent "full reshuffle" escape
    // hatch; this is the GA's version of the same idea.
    for (let i = 0; i < RANDOM_IMMIGRANTS_PER_GEN && nextGen.length < POPULATION_SIZE; i++) {
      nextGen.push(randomIndividual(baseInstances, autoAngles));
    }
    while (nextGen.length < POPULATION_SIZE) {
      const parentA = sortedPop[selectParentIndex(sortedPop.length)];
      const parentB = sortedPop[selectParentIndex(sortedPop.length)];
      const [childA, childB] = crossover(parentA, parentB);
      nextGen.push(mutate(childA, autoAngles));
      if (nextGen.length < POPULATION_SIZE) nextGen.push(mutate(childB, autoAngles));
    }
    population = nextGen;
  }

  if (!best) throw new NestingError('Nesting failed: no arrangement found');
  return best;
}
