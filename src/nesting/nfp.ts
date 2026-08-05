import ClipperLib = require('clipper-lib');
import { Point, Polygon } from './geometry';

// mm -> Clipper integer units. Clipper requires integer coordinates for numerical robustness;
// 1000x gives micron precision, comfortably within safe integer range for mm-scale drawings.
const CLIPPER_SCALE = 1000;

function toClipperPath(poly: Polygon): ClipperLib.Path {
  return poly.map(([x, y]) => ({ X: Math.round(x * CLIPPER_SCALE), Y: Math.round(y * CLIPPER_SCALE) }));
}

function fromClipperPath(path: ClipperLib.Path): Point[] {
  return path.map((p) => [p.X / CLIPPER_SCALE, p.Y / CLIPPER_SCALE] as Point);
}

// Inflates a closed polygon outward by `delta` (mm). Used to bake a required gap directly into
// NFP computation, so the resulting candidate positions already respect spacing without a
// separate distance check downstream.
//
// NOTE: verified empirically against this clipper-lib version (6.4.2) — its @types package has
// at least one wrong member name (EndType_ instead of EndType) that doesn't match the runtime
// module, so this file deliberately avoids relying on anything from @types/clipper-lib beyond
// basic shape typing, and every ClipperLib.* member used here (EndType.etClosedPolygon,
// JoinType.jtMiter, ClipperOffset, Clipper.MinkowskiDiff) was confirmed against the actual
// runtime export list rather than assumed from the type declarations.
export function inflate(poly: Polygon, delta: number): Polygon {
  if (delta <= 0) return poly;
  const co = new ClipperLib.ClipperOffset();
  co.AddPath(toClipperPath(poly), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const solution: ClipperLib.Paths = [];
  co.Execute(solution, delta * CLIPPER_SCALE);
  if (solution.length === 0) return poly;
  // Offsetting a concave polygon can split it into multiple pieces; keep the largest as a
  // reasonable stand-in for "the main outline" — good enough as an NFP input, since final
  // placement validity is always re-checked exactly by the caller regardless.
  let largest = solution[0];
  for (const s of solution) if (s.length > largest.length) largest = s;
  return fromClipperPath(largest);
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

  const obstaclePath = toClipperPath(obstacleToUse);
  const movingPath = toClipperPath(movingNormalized);

  let nfpPaths: ClipperLib.Paths;
  try {
    // Argument order matters and is NOT the naive "(stationary, moving)" reading — verified
    // empirically that ClipperLib.Clipper.MinkowskiDiff(A, B) computes B - A (as point sets), and
    // we want translation vectors T such that (moving + T) touches `obstacle`, i.e.
    // T in (obstacle - moving) — so `moving` is passed first, `obstacle` second.
    nfpPaths = ClipperLib.Clipper.MinkowskiDiff(movingPath, obstaclePath);
  } catch {
    return [];
  }

  const points: Point[] = [];
  for (const path of nfpPaths) {
    for (const p of path) points.push([p.X / CLIPPER_SCALE, p.Y / CLIPPER_SCALE]);
  }
  return points;
}
