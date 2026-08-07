import type { Clipper2ZFactoryFunction, MainModule, PathD, PathsD } from 'clipper2-wasm/dist/clipper2z';
import { Point, Polygon, polygonSignedArea } from './geometry';

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

// Returns the no-fit-polygon between `obstacle` and `movingNormalized` as its actual loop(s)
// (not flattened to a point cloud) — every vertex is a position where the candidate would sit
// exactly touching the obstacle (or `gap` away, if gap > 0) without overlapping it, and the edges
// between vertices are themselves valid touching positions (used by the boundary-slide search in
// packer.ts to consider more than just the discrete vertices).
export function nfpLoops(obstacle: Polygon, movingNormalized: Polygon, gap: number): Polygon[] {
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
    const loops: Polygon[] = [];
    for (let i = 0; i < nfpPaths.size(); i++) loops.push(fromPathD(nfpPaths.get(i)));

    // MinkowskiDiffD reliably returns a second, oppositely-wound "hole" loop alongside the real
    // outer touching-boundary loop — verified empirically (same "don't trust the naive reading"
    // lesson as the argument order above) by checking what its vertices actually mean: for two
    // simple 10x10/4x4 squares its bbox is exactly [0,0]-[6,6], i.e. precisely the sub-region of
    // translations where the moving shape is fully swallowed inside the obstacle (an anchor there
    // always overlaps, at every single point — not a touching position at all, just an inner
    // boundary between "swallowed" and "partially overlapping"). A concave notch's own inner
    // corner vertex (the actual touching position we care about) always lands on the genuine
    // outer loop, not this one — confirmed on the same L-shape-notch case packer.test.ts exercises
    // — so discarding negative-signed-area loops removes only ever-invalid noise, never a real
    // candidate.
    return loops.filter((loop) => polygonSignedArea(loop) > 0);
  } catch (e) {
    if (process.env.NFP_DEBUG) console.error('nfpLoops: MinkowskiDiffD threw', e);
    return [];
  } finally {
    movingPath.delete();
    obstaclePath.delete();
    if (nfpPaths) nfpPaths.delete();
  }
}

// Flattened-to-points convenience wrapper over nfpLoops, for callers that only need candidate
// positions and don't care about which loop/edge each vertex came from.
export function nfpAnchors(obstacle: Polygon, movingNormalized: Polygon, gap: number): Point[] {
  const points: Point[] = [];
  for (const loop of nfpLoops(obstacle, movingNormalized, gap)) points.push(...loop);
  return points;
}

// Merges multiple polygon loops (e.g. several obstacles' NFPs, all computed against the same
// moving shape) into the boundary of their combined union — i.e. the true boundary of "every
// position where the moving shape would overlap AT LEAST ONE of them". Walking this combined
// boundary (rather than any one obstacle's NFP in isolation) is what lets a slide search follow
// one obstacle's edge and then naturally continue along a second obstacle's edge where it takes
// over, instead of only snapping to each NFP's own discrete vertices.
export function unionPolygons(loops: Polygon[]): Polygon[] {
  const usable = loops.filter((l) => l.length >= 3);
  if (usable.length <= 1) return usable;

  const m = requireModule();
  const paths = new m.PathsD();
  const madePaths: PathD[] = [];
  try {
    for (const loop of usable) {
      const path = m.MakePathD(toFlat(loop));
      madePaths.push(path);
      paths.push_back(path);
    }

    let unioned: PathsD | null = null;
    try {
      unioned = m.UnionSelfD(paths, m.FillRule.NonZero, DECIMAL_PLACES);
      const result: Polygon[] = [];
      for (let i = 0; i < unioned.size(); i++) result.push(fromPathD(unioned.get(i)));
      return result;
    } catch (e) {
      if (process.env.NFP_DEBUG) console.error('unionPolygons: UnionSelfD threw', e);
      return usable;
    } finally {
      if (unioned) unioned.delete();
    }
  } finally {
    for (const p of madePaths) p.delete();
    paths.delete();
  }
}
