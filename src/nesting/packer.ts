import { EPS, Point, Polygon, boundingBox, boundingBoxDistance, netArea, placeAtAnchor, polygonsOverlap, polygonsWithinDistance, rotateAroundCentroid, simplifyToPointBudget, translate } from './geometry';
import { inflate, nfpAnchors } from './nfp';
import { NestingError, PackResult, PartInstance, Placement, SheetFootprint, SheetSize } from './types';

function normalizeToOrigin(poly: Polygon): Polygon {
  const bb = boundingBox(poly);
  return translate(poly, -bb.minX, -bb.minY);
}

// Minkowski-diff NFP computation cost scales with both polygons' point counts — this is a lighter
// proxy shape used ONLY for NFP search (the actual placed/output geometry is untouched — full
// detail is still exactly validated by fitsOnSheet below).
const NFP_SEARCH_POINTS = 40;

// Simplifying AND gap-inflating an obstacle doesn't depend on the moving part's rotation, but
// would otherwise be redone from scratch every time the same placed part is checked as an
// obstacle again. Cached per obstacle polygon (keyed by object identity, stable across an
// attempt's structural sharing), so each unique placed part only ever pays for simplify+inflate
// once, no matter how many later parts check against it.
const searchObstacleCache = new WeakMap<Polygon, Polygon>();

function prepareSearchObstacle(obstacle: Polygon, gap: number): Polygon {
  const cached = searchObstacleCache.get(obstacle);
  if (cached) return cached;
  const simplified = simplifyToPointBudget(obstacle, NFP_SEARCH_POINTS, 0.5);
  const prepared = gap > 0 ? inflate(simplified, gap) : simplified;
  searchObstacleCache.set(obstacle, prepared);
  return prepared;
}

// Candidate bottom-left anchor points for placing `movingNormalized` (a candidate part's rotated
// outline, translated so its own bbox-min corner sits at (0,0)) against every already-placed part
// on this sheet: the sheet origin, plus every vertex of the true no-fit-polygon computed against
// each obstacle (via Minkowski difference — see nfp.ts). Each NFP vertex is an exact touching
// position for the (simplified) search shapes, not an approximation — the actual placement is
// still validated at full detail by fitsOnSheet before being accepted.
function candidateAnchors(sheet: SheetSize, placed: Polygon[], movingNormalized: Polygon, gap: number): Point[] {
  const seen = new Set<string>();
  const anchors: Point[] = [];

  const tryAdd = (x: number, y: number) => {
    if (x < -EPS || y < -EPS || x > sheet.width + EPS || y > sheet.height + EPS) return;
    const key = Math.round(x * 1000) + ',' + Math.round(y * 1000);
    if (seen.has(key)) return;
    seen.add(key);
    anchors.push([x, y]);
  };

  tryAdd(0, 0);

  const searchMoving = simplifyToPointBudget(movingNormalized, NFP_SEARCH_POINTS, 0.5);
  for (const obstacle of placed) {
    const searchObstacle = prepareSearchObstacle(obstacle, gap);
    // gap already baked into searchObstacle above (or n/a if gap<=0) — pass 0 here so nfpAnchors
    // doesn't redundantly inflate it again itself.
    for (const [x, y] of nfpAnchors(searchObstacle, searchMoving, 0)) tryAdd(x, y);
  }

  if (process.env.NFP_DEBUG) console.error(`candidateAnchors: ${anchors.length} anchors from ${placed.length} obstacle(s)`);
  anchors.sort((p1, p2) => p1[1] - p2[1] || p1[0] - p2[0]);
  return anchors.length > MAX_ANCHORS ? anchors.slice(0, MAX_ANCHORS) : anchors;
}

// A generous cap, not a routine limiter — NFP-based candidates are already naturally bounded by
// obstacle complexity, this just guards against a pathological case (many obstacles, each
// contributing a detailed NFP) piling up unbounded.
const MAX_ANCHORS = 300;

function fitsOnSheet(poly: Polygon, sheet: SheetSize, placed: Polygon[], gap: number): boolean {
  const bb = boundingBox(poly);
  if (bb.minX < -EPS || bb.minY < -EPS || bb.maxX > sheet.width + EPS || bb.maxY > sheet.height + EPS) {
    return false;
  }
  for (const p of placed) {
    // Cheap lower-bound check first: most candidate positions across a sheet are nowhere near
    // most already-placed parts, and this skips the O(edges_a * edges_b) exact checks for all
    // of them.
    if (boundingBoxDistance(poly, p) > gap + EPS) continue;
    if (polygonsOverlap(poly, p)) return false;
    if (gap > EPS && polygonsWithinDistance(poly, p, gap)) return false;
  }
  return true;
}

interface PlacementResult {
  outline: Polygon;
}

// Tries to place `part` — at its already-assigned rotationDeg (see PartInstance) — onto one
// sheet. Rotation is NOT searched here: it's a gene the caller's genetic algorithm evolves across
// attempts (matches SVGnest/Deepnest — cheap greedy placement per attempt, quality from evolving
// many attempts, not from exhaustively re-trying every angle inside each one).
//
// Among all valid candidate positions, picks whichever leaves the SMALLEST resulting overall
// bounding box (width weighted more than height, matching e-cut/SVGnest's own placement
// heuristic — "compress in the direction of gravity") — not simply the lowest-Y position. Pure
// lowest-Y was measured to squeeze a small part into a leftover gap deep inside an already-placed
// concave shape's own bounding box (technically valid, zero overlap) while leaving large, genuinely
// open areas elsewhere on the sheet untouched, since a tight nook 8 shapes deep in can still sort
// as "lower" than open space that happens to start slightly higher up.
function tryPlaceOnSheet(part: PartInstance, sheet: SheetSize, placed: Polygon[], gap: number): PlacementResult | null {
  const rotated = rotateAroundCentroid(part.outline, part.rotationDeg);
  const normalized = normalizeToOrigin(rotated);
  const anchors = candidateAnchors(sheet, placed, normalized, gap);

  let baseMinX = 0, baseMinY = 0, baseMaxX = 0, baseMaxY = 0;
  if (placed.length > 0) {
    baseMinX = Infinity; baseMinY = Infinity; baseMaxX = -Infinity; baseMaxY = -Infinity;
    for (const p of placed) {
      const bb = boundingBox(p);
      if (bb.minX < baseMinX) baseMinX = bb.minX;
      if (bb.minY < baseMinY) baseMinY = bb.minY;
      if (bb.maxX > baseMaxX) baseMaxX = bb.maxX;
      if (bb.maxY > baseMaxY) baseMaxY = bb.maxY;
    }
  }

  let best: { outline: Polygon; score: number } | null = null;
  for (const anchor of anchors) {
    const candidate = placeAtAnchor(rotated, anchor);
    if (!fitsOnSheet(candidate, sheet, placed, gap)) continue;
    const bb = boundingBox(candidate);
    const width = Math.max(baseMaxX, bb.maxX) - Math.min(baseMinX, bb.minX);
    const height = Math.max(baseMaxY, bb.maxY) - Math.min(baseMinY, bb.minY);
    const score = width * 2 + height;
    if (!best || score < best.score) best = { outline: candidate, score };
  }
  return best ? { outline: best.outline } : null;
}

// Node is single-threaded, and this loop is the only CPU-heavy part of the whole API — a single
// attempt can still take long enough on a large job to block the event loop for a real stretch,
// freezing every other request the server is handling for that same stretch. Yielding is
// time-based rather than every-N-parts since per-part cost isn't uniform (it grows as more parts
// get placed) — it checks in regardless of how expensive the parts around it turn out to be.
const YIELD_INTERVAL_MS = 100;

function computeFootprints(sheetsPlaced: Polygon[][]): SheetFootprint[] {
  return sheetsPlaced.map((polys) => {
    let maxX = 0, maxY = 0;
    for (const poly of polys) {
      const bb = boundingBox(poly);
      if (bb.maxX > maxX) maxX = bb.maxX;
      if (bb.maxY > maxY) maxY = bb.maxY;
    }
    return { width: maxX, height: maxY };
  });
}

// Packs every instance (in the given order, each at its already-assigned rotationDeg) onto one or
// more sheets using greedy bottom-left-fill via true NFP-derived touching positions. A part that
// doesn't fit on any sheet placed so far opens a new sheet; earlier sheets are tried first so gaps
// left by earlier, larger parts can still be filled by later, smaller ones.
export async function packAttempt(sheet: SheetSize, gap: number, instances: PartInstance[]): Promise<PackResult> {
  const sheetsPlaced: Polygon[][] = [[]];
  const placements: Placement[] = [];
  let lastYieldAt = Date.now();

  for (const part of instances) {
    let sheetIndex = -1;
    let result: PlacementResult | null = null;

    for (let i = 0; i < sheetsPlaced.length && !result; i++) {
      result = tryPlaceOnSheet(part, sheet, sheetsPlaced[i], gap);
      if (result) sheetIndex = i;
    }

    if (!result) {
      sheetsPlaced.push([]);
      sheetIndex = sheetsPlaced.length - 1;
      result = tryPlaceOnSheet(part, sheet, sheetsPlaced[sheetIndex], gap);
      if (!result) {
        throw new NestingError(`Part "${part.partId}" does not fit on an empty sheet at rotation ${part.rotationDeg}`);
      }
    }

    sheetsPlaced[sheetIndex].push(result.outline);
    const bb = boundingBox(result.outline);
    placements.push({
      instanceId: part.instanceId,
      partId: part.partId,
      sheetIndex,
      x: bb.minX,
      y: bb.minY,
      rotationDeg: part.rotationDeg,
      outline: result.outline,
    });

    if (Date.now() - lastYieldAt >= YIELD_INTERVAL_MS) {
      lastYieldAt = Date.now();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  const sheetFootprints = computeFootprints(sheetsPlaced);
  const usedArea = instances.reduce((sum, p) => sum + netArea(p.outline, p.holes), 0);
  const footprintArea = sheetFootprints.reduce((sum, f) => sum + f.width * f.height, 0);

  return {
    sheetsUsed: sheetsPlaced.length,
    placements,
    sheetFootprints,
    utilizationPct: footprintArea > 0 ? (usedArea / footprintArea) * 100 : 0,
  };
}
