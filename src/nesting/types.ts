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

export interface PackResult {
  sheetsUsed: number;
  placements: Placement[];
  utilizationPct: number;
}

export interface PassBudget {
  timeBudgetSec?: number;
  maxIterations?: number;
}

// Thrown for nesting-domain failures (e.g. a part larger than the sheet) as opposed to bugs.
export class NestingError extends Error {}
