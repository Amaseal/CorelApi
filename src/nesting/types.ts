import { Polygon } from './geometry';

export type RotationMode = 'free' | 'locked' | 'step90';

export interface SheetSize {
  width: number;
  height: number;
}

export interface PartInstance {
  instanceId: string;
  partId: string;
  outline: Polygon;
  holes: Polygon[];
  rotationMode: RotationMode;
  // The ONE rotation angle this instance is placed at for a given attempt — not exhaustively
  // searched by the packer. Matches SVGnest/Deepnest: rotation is a gene the genetic algorithm
  // evolves across many cheap attempts, not something re-tried 24 ways inside every single one.
  rotationDeg: number;
}

export interface Placement {
  instanceId: string;
  partId: string;
  sheetIndex: number;
  x: number;
  y: number;
  rotationDeg: number;
  outline: Polygon;
}

export interface SheetFootprint {
  width: number;
  height: number;
}

export interface PackResult {
  sheetsUsed: number;
  placements: Placement[];
  // Actual bounding size of the placed parts on each sheet — NOT the configured sheet size,
  // which is only an upper bound. This is what should drive both the optimizer's scoring and
  // any "how much material did this actually use" reporting (e.g. roll length consumed).
  sheetFootprints: SheetFootprint[];
  utilizationPct: number;
}

export interface PassBudget {
  timeBudgetSec?: number;
  maxIterations?: number;
  // Fresh random individuals injected into the GA population each generation, on top of elitism
  // and crossover/mutation — fights premature convergence (crossover/mutation alone can only ever
  // recombine genetic material already in the population, so once it converges toward similar
  // individuals nothing pushes back against a local optimum). Optional so callers that don't care
  // get the tuned default in nest.ts.
  randomImmigrantsPerGen?: number;
}

// Thrown for nesting-domain failures (e.g. a part larger than the sheet) as opposed to bugs.
export class NestingError extends Error {}
