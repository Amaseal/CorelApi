import { EPS, Point, Polygon, boundingBox, boundingBoxDistance, insertOnEdge, nearestPointOnLoops, netArea, placeAtAnchor, polygonsOverlap, polygonsWithinDistance, rotateAroundCentroid, simplifyToPointBudget, translate } from './geometry';
import { inflate, nfpLoops, unionPolygons } from './nfp';
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

// Candidate bottom-left anchor points for placing a part against every already-placed obstacle on
// this sheet: the sheet origin, plus every vertex of each obstacle's already-computed NFP loops
// (see nfpLoops in nfp.ts — true no-fit-polygons via Minkowski difference). Each NFP vertex is an
// exact touching position for the (simplified) search shapes, not an approximation — the actual
// placement is still validated at full detail by fitsOnSheet before being accepted. Takes the
// already-computed loops (rather than obstacles) so tryPlaceOnSheet can reuse the same Minkowski
// results for the boundary-slide refinement below instead of recomputing them.
function candidateAnchors(sheet: SheetSize, perObstacleLoops: Polygon[][]): Point[] {
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
  for (const loops of perObstacleLoops) {
    for (const loop of loops) {
      for (const [x, y] of loop) tryAdd(x, y);
    }
  }

  if (process.env.NFP_DEBUG) console.error(`candidateAnchors: ${anchors.length} anchors from ${perObstacleLoops.length} obstacle(s)`);
  anchors.sort((p1, p2) => p1[1] - p2[1] || p1[0] - p2[0]);
  return anchors.length > MAX_ANCHORS ? anchors.slice(0, MAX_ANCHORS) : anchors;
}

// A true pathological-case guard, not a routine limiter — measured directly on a real 17-part job
// that candidate counts climb past 300-450+ by the time 8-13 parts are already placed, which is
// completely normal, not pathological. The old 300 cap was silently truncating past that on every
// real job of this size — and since candidates are sorted lowest-Y-first before truncating, what
// got discarded was specifically the candidates sitting in open space ABOVE a tall stack, which is
// exactly where a part needs to go once the space near y=0 is full. That caused real, valid
// single-sheet layouts to spuriously overflow onto a second sheet, since the search never even
// considered the wide-open space that was actually available.
const MAX_ANCHORS = 5000;

// Safety cap on how many boundary vertices a single slide direction will step through — the walk
// already stops as soon as a step fails to strictly improve the score, so this only guards against
// a pathological cycle (e.g. floating-point noise making two adjacent points compare as endlessly
// "equal-ish"), not a normal termination condition.
const SLIDE_MAX_STEPS = 200;

// A candidate part often lands touching one obstacle at a point where sliding it further (along
// that obstacle's own edge, or past it onto a second obstacle's edge) would pack it tighter than
// any single NFP vertex does on its own — e.g. resting against a straight edge partway between two
// of that edge's endpoints, or rounding a corner from one obstacle's boundary onto a neighbor's.
// `boundaryLoops` is the union of every obstacle's NFP (see unionPolygons) — its edges are exactly
// the set of positions where the moving shape touches at least one obstacle without overlapping
// any of them — so walking vertex-to-vertex along it from the best anchor found above, in
// whichever direction keeps improving the placement score, finds these in-between resting spots
// without needing a physics simulation.
function slideAlongBoundary(
  boundaryLoops: Polygon[],
  startAnchor: Point,
  startScore: number,
  evaluate: (anchor: Point) => number | null,
): { anchor: Point; score: number } | null {
  if (boundaryLoops.length === 0) return null;

  const located = nearestPointOnLoops(startAnchor, boundaryLoops);
  // Only slide from a point that's actually (close to) on this boundary — e.g. the sheet-origin
  // anchor generally isn't constrained by any obstacle at all, so there's nothing to slide along.
  if (!located || located.dist > 0.05) return null;

  const { loop, index: startIndex } = insertOnEdge(
    boundaryLoops[located.loopIndex], located.edgeIndex, located.t, located.point,
  );
  if (loop.length < 2) return null;

  let bestAnchor = startAnchor;
  let bestScore = startScore;

  for (const direction of [1, -1] as const) {
    let idx = startIndex;
    let currentScore = startScore;
    for (let step = 0; step < SLIDE_MAX_STEPS; step++) {
      idx = (idx + direction + loop.length) % loop.length;
      if (idx === startIndex) break; // walked all the way around back to the start
      const candidateScore = evaluate(loop[idx]);
      if (candidateScore === null || candidateScore >= currentScore - EPS) break; // invalid, or no longer improving
      currentScore = candidateScore;
      if (currentScore < bestScore) { bestScore = currentScore; bestAnchor = loop[idx]; }
    }
  }

  return bestScore < startScore - EPS ? { anchor: bestAnchor, score: bestScore } : null;
}

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

interface BaseBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// The combined bounding box of a set of already-placed outlines — a phantom (0,0)-(0,0) point
// when there are none, so even the very first part placed on a sheet is scored against the
// origin (matching the sheet-origin anchor candidate below). Precomputed once per tryPlaceOnSheet
// call (not per candidate) since it doesn't depend on the candidate being scored.
function computeBaseBBox(others: Polygon[]): BaseBBox {
  if (others.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of others) {
    const bb = boundingBox(p);
    if (bb.minX < minX) minX = bb.minX;
    if (bb.minY < minY) minY = bb.minY;
    if (bb.maxX > maxX) maxX = bb.maxX;
    if (bb.maxY > maxY) maxY = bb.maxY;
  }
  return { minX, minY, maxX, maxY };
}

// The resulting overall bounding box if `candidate` joins `base` — height weighted more than
// width. Sheet width is a hard, fixed cap (roll width, already "paid for" whether used or not);
// height is the actual cost driver (roll length consumed — see nest.ts's isBetter). A part that
// can settle at a taller-but-narrower spot vs. a shorter-but-wider one should prefer the wider
// one, since unused width is pure waste it could have traded for less height. This was previously
// weighted the other way (width * 2 + height) and measured to actively leave width unused on a
// real job — e.g. one real result used only 1062mm of a 1312mm-wide sheet while growing to
// 1358mm tall, when spreading into that spare ~250mm of width had real room to reduce height.
function footprintScoreAgainst(candidate: Polygon, base: BaseBBox): number {
  const bb = boundingBox(candidate);
  const width = Math.max(base.maxX, bb.maxX) - Math.min(base.minX, bb.minX);
  const height = Math.max(base.maxY, bb.maxY) - Math.min(base.minY, bb.minY);
  return width + height * 2;
}

interface PlacementResult {
  outline: Polygon;
  rotationDeg: number;
}

// Granularity for 'free' mode's local rotation search below — matches nest.ts's own step size for
// the GA's rotation gene (kept as a separate constant rather than a shared import so packer.ts and
// nest.ts don't need to depend on each other for a single number; both represent the same
// underlying "how fine-grained is a rotation step" decision and should be changed together).
const FREE_ROTATION_STEP_DEG = 15;
// How many steps on either side of the GA-assigned seed angle to also try at placement time (e.g.
// 2 tries seed, seed +/-15 deg, seed +/-30 deg -- 5 angles total). Deliberately a narrow LOCAL
// search around the gene's seed, not the full 24-angle range: a full per-part search every
// placement would multiply attempt cost by ~24x, collapsing the attempt count the GA depends on
// for its own (evolutionary, cross-attempt) exploration. This instead multiplies cost by ~5x,
// trading some attempt count for finding a genuinely tight fit within each one -- closer to how
// e-cut spends its own budget (far fewer tries, each one considering more per part).
const FREE_LOCAL_SEARCH_STEPS = 2;
const STEP90_ANGLES = [0, 90, 180, 270];

// The rotation angles actually tried when placing this part on this attempt. 'locked' has exactly
// one legal angle (an explicit user constraint -- print orientation, fabric grain -- never
// auto-rotated away from). 'step90' has only 4 legal angles total, cheap enough to always try all
// of them rather than trusting whichever one the GA gene happened to pick. 'free' searches a
// handful of neighbors around the GA's seed angle (see FREE_LOCAL_SEARCH_STEPS) -- the seed still
// comes from evolution across attempts (see nest.ts), this only refines it locally within one.
function candidateRotations(part: PartInstance): number[] {
  if (part.rotationMode === 'locked') return [0];
  if (part.rotationMode === 'step90') return STEP90_ANGLES;

  const seed = part.rotationDeg;
  const angles = new Set<number>([seed]);
  for (let k = 1; k <= FREE_LOCAL_SEARCH_STEPS; k++) {
    angles.add(((seed + k * FREE_ROTATION_STEP_DEG) % 360 + 360) % 360);
    angles.add(((seed - k * FREE_ROTATION_STEP_DEG) % 360 + 360) % 360);
  }
  return [...angles];
}

// Tries to place `part`, AT ONE GIVEN ROTATION, onto one sheet. Among all valid candidate
// positions, picks whichever leaves the SMALLEST resulting overall bounding box (see
// footprintScoreAgainst) — not simply the lowest-Y position. Pure lowest-Y was measured to squeeze
// a small part into a leftover gap deep inside an already-placed concave shape's own bounding box
// (technically valid, zero overlap) while leaving large, genuinely open areas elsewhere on the
// sheet untouched, since a tight nook 8 shapes deep in can still sort as "lower" than open space
// that happens to start slightly higher up.
function tryPlaceAtRotation(
  outline: Polygon, rotationDeg: number, sheet: SheetSize, placed: Polygon[], gap: number,
): PlacementResult | null {
  const rotated = rotateAroundCentroid(outline, rotationDeg);
  const normalized = normalizeToOrigin(rotated);

  const searchMoving = simplifyToPointBudget(normalized, NFP_SEARCH_POINTS, 0.5);
  // gap is already baked into each searchObstacle by prepareSearchObstacle, so nfpLoops is called
  // with gap 0 here to avoid inflating it a second time.
  const perObstacleLoops = placed.map((obstacle) => nfpLoops(prepareSearchObstacle(obstacle, gap), searchMoving, 0));
  const anchors = candidateAnchors(sheet, perObstacleLoops);
  const base = computeBaseBBox(placed);

  const evaluate = (anchor: Point): number | null => {
    const candidate = placeAtAnchor(rotated, anchor);
    if (!fitsOnSheet(candidate, sheet, placed, gap)) return null;
    return footprintScoreAgainst(candidate, base);
  };

  let bestAnchor: Point | null = null;
  let bestScore = Infinity;
  for (const anchor of anchors) {
    const score = evaluate(anchor);
    if (score !== null && score < bestScore) { bestScore = score; bestAnchor = anchor; }
  }
  if (!bestAnchor) return null;

  if (placed.length > 0) {
    const boundaryLoops = unionPolygons(perObstacleLoops.flat());
    const slid = slideAlongBoundary(boundaryLoops, bestAnchor, bestScore, evaluate);
    if (slid) { bestAnchor = slid.anchor; bestScore = slid.score; }
  }

  return { outline: placeAtAnchor(rotated, bestAnchor), rotationDeg };
}

// Tries every candidate rotation for `part` (see candidateRotations) against the same sheet, and
// keeps whichever (rotation, position) combination scores best -- this is the local search that
// lets a single attempt find a genuinely tight fit, rather than only ever trying whatever rotation
// the GA's gene happened to assign for the whole attempt (see nest.ts).
function tryPlaceOnSheet(part: PartInstance, sheet: SheetSize, placed: Polygon[], gap: number): PlacementResult | null {
  let best: PlacementResult | null = null;
  let bestScore = Infinity;

  for (const rotationDeg of candidateRotations(part)) {
    const result = tryPlaceAtRotation(part.outline, rotationDeg, sheet, placed, gap);
    if (!result) continue;
    const score = footprintScoreAgainst(result.outline, computeBaseBBox(placed));
    if (score < bestScore) { bestScore = score; best = result; }
  }

  return best;
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
        throw new NestingError(`Part "${part.partId}" does not fit on an empty sheet at any tried rotation`);
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
      rotationDeg: result.rotationDeg,
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
