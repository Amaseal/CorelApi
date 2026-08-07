import type { Clipper2ZFactoryFunction, MainModule, PathD, PathsD } from 'clipper2-wasm/dist/clipper2z';
import { Point, Polygon } from './geometry';

// clipper2-wasm ships dual ESM/CJS builds without a proper "exports" map pairing its "main" (CJS,
// used by our commonjs project) with its "types" field (which points at the ESM build's .d.ts) —
// so a plain `import` of the value has no declaration file under our tsconfig. require() sidesteps
// that; the type-only import above still gives real type safety for everything after this line.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Clipper2ZFactory = require('clipper2-wasm') as Clipper2ZFactoryFunction;

// Decimal places of precision Clipper2 keeps when internally converting our mm-scale doubles to
// its integer representation. 4 gives sub-micron precision — comfortably more than needed here.
const DECIMAL_PLACES = 4;

let clipperModule: MainModule | null = null;

// Must be called once, and awaited, before any nesting job runs — see index.ts's startup sequence.
// The module is loaded once and reused for the lifetime of the process; nfp.ts's exported
// functions stay synchronous-shaped for all their (many, deep in the beam search) call sites.
export async function initClipper(): Promise<void> {
  if (clipperModule) return;
  clipperModule = await Clipper2ZFactory();
}

function requireModule(): MainModule {
  if (!clipperModule) {
    throw new Error('Clipper2 WASM module not initialized — call initClipper() at server startup before nesting');
  }
  return clipperModule;
}

function toFlat(poly: Polygon): number[] {
  const flat: number[] = [];
  for (const [x, y] of poly) { flat.push(x, y); }
  return flat;
}

function fromPathD(path: PathD): Point[] {
  const points: Point[] = [];
  const n = path.size();
  for (let i = 0; i < n; i++) {
    const p = path.get(i);
    points.push([p.x, p.y]);
  }
  return points;
}

// Inflates a closed polygon outward by `delta` (mm). Used to bake a required gap directly into
// NFP computation, so the resulting candidate positions already respect spacing without a
// separate distance check downstream.
//
// NOTE: these WASM-backed objects (PathD, PathsD, ...) are Emscripten embind bindings over C++
// values, not plain JS objects — they must be explicitly `.delete()`d after use or their memory
// leaks on the WASM heap for the lifetime of the (long-running) server process. Every object
// created in this file is deleted in a finally block, even on error.
export function inflate(poly: Polygon, delta: number): Polygon {
  if (delta <= 0) return poly;
  const m = requireModule();

  const path = m.MakePathD(toFlat(poly));
  const paths = new m.PathsD();
  paths.push_back(path);

  let inflated: PathsD | null = null;
  try {
    inflated = m.InflatePathsD(paths, delta, m.JoinType.Miter, m.EndType.Polygon, 2, DECIMAL_PLACES, 0);
    if (inflated.size() === 0) return poly;
    // Offsetting a concave polygon can split it into multiple pieces; keep the largest as a
    // reasonable stand-in for "the main outline" — good enough as an NFP input, since final
    // placement validity is always re-checked exactly by the caller regardless.
    let largestIdx = 0;
    let largestSize = 0;
    for (let i = 0; i < inflated.size(); i++) {
      const size = inflated.get(i).size();
      if (size > largestSize) { largestSize = size; largestIdx = i; }
    }
    return fromPathD(inflated.get(largestIdx));
  } finally {
    path.delete();
    paths.delete();
    if (inflated) inflated.delete();
  }
}

// Returns candidate translation vectors — in the same "bbox-min-corner target" sense used
// elsewhere in this module — for placing `movingNormalized` (a candidate part's rotated outline,
// already translated so its own bounding-box min corner sits at (0,0)) against one obstacle
// polygon (an already-placed part, in absolute sheet coordinates).
//
// Every vertex of the resulting no-fit-polygon is a position where the candidate would sit
// exactly touching the obstacle (or `gap` away, if gap > 0) without overlapping it — a compact,
// geometrically meaningful set of positions, in contrast to exhaustively scanning every placed
// part's own vertices as an approximation (which scales badly and produces mostly-irrelevant
// candidates; see packer.ts's history before this).
export function nfpAnchors(obstacle: Polygon, movingNormalized: Polygon, gap: number): Point[] {
  const obstacleToUse = gap > 0 ? inflate(obstacle, gap) : obstacle;
  if (obstacleToUse.length < 3 || movingNormalized.length < 3) return [];

  const m = requireModule();
  const movingPath = m.MakePathD(toFlat(movingNormalized));
  const obstaclePath = m.MakePathD(toFlat(obstacleToUse));

  let nfpPaths: PathsD | null = null;
  try {
    // Argument order matters and is NOT the naive "(stationary, moving)" reading — verified
    // empirically (same convention as Clipper1's clipper-lib) that MinkowskiDiffD(A, B, ...)
    // computes B - A (as point sets), and we want translation vectors T such that
    // (moving + T) touches `obstacle`, i.e. T in (obstacle - moving) — so `moving` is passed
    // first, `obstacle` second.
    nfpPaths = m.MinkowskiDiffD(movingPath, obstaclePath, true, DECIMAL_PLACES);
    const points: Point[] = [];
    for (let i = 0; i < nfpPaths.size(); i++) {
      for (const pt of fromPathD(nfpPaths.get(i))) points.push(pt);
    }
    return points;
  } catch (e) {
    if (process.env.NFP_DEBUG) console.error('nfpAnchors: MinkowskiDiffD threw', e);
    return [];
  } finally {
    movingPath.delete();
    obstaclePath.delete();
    if (nfpPaths) nfpPaths.delete();
  }
}
