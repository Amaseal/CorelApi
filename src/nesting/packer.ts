import { EPS, Point, Polygon, boundingBox, boundingBoxDistance, netArea, placeAtAnchor, polygonsOverlap, polygonsWithinDistance, rotateAroundCentroid } from './geometry';
import { NestingError, PackResult, PartInstance, Placement, RotationMode, SheetFootprint, SheetSize } from './types';

const FREE_ROTATION_STEP_DEG = 15;

function rotationsFor(mode: RotationMode): number[] {
  if (mode === 'locked') return [0];
  if (mode === 'step90') return [0, 90, 180, 270];
  const angles: number[] = [];
  for (let a = 0; a < 360; a += FREE_ROTATION_STEP_DEG) angles.push(a);
  return angles;
}

// Candidate bottom-left anchor points: sheet origin plus every VERTEX of every already-placed
// part's actual outline. This is a cheap stand-in for a full no-fit-polygon touching-point
// search: using real polygon vertices — not just bounding-box corners — lets the candidate's
// corner land snug against a concave notch, an angled edge, or any other contour feature a
// coarse bbox-corner grid is blind to, without computing Minkowski sums. It's still an
// approximation (only the candidate's own bbox-min corner is tried against these points, not
// every vertex pairing), but it's a meaningfully closer approximation to a real touching-point
// search than bounding boxes alone.
function candidateAnchors(sheet: SheetSize, placed: Polygon[]): Point[] {
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
  for (const poly of placed) {
    for (const [x, y] of poly) tryAdd(x, y);
  }

  anchors.sort((p1, p2) => p1[1] - p2[1] || p1[0] - p2[0]);
  // Bottom-left-fill only ever prefers the lowest-y (then lowest-x) candidates anyway — once the
  // placed-part count makes the full vertex list large, the highest ones are essentially never
  // reached before an earlier one already fits. Capping keeps cost from growing without bound as
  // a job's part/vertex count grows, at the cost of occasionally missing a valid low spot that
  // happened to sort past the cap (rare, and the multi-attempt search can still find it via a
  // different ordering).
  return anchors.length > MAX_ANCHORS ? anchors.slice(0, MAX_ANCHORS) : anchors;
}

const MAX_ANCHORS = 150;

function fitsOnSheet(poly: Polygon, sheet: SheetSize, placed: Polygon[], gap: number): boolean {
  const bb = boundingBox(poly);
  if (bb.minX < -EPS || bb.minY < -EPS || bb.maxX > sheet.width + EPS || bb.maxY > sheet.height + EPS) {
    return false;
  }
  for (const p of placed) {
    // Cheap lower-bound check first: most candidate positions across a sheet are nowhere near
    // most already-placed parts, and this skips the O(edges_a * edges_b) exact checks for all
    // of them — without it, this was the main cost behind real jobs blocking the event loop for
    // tens of seconds at a time.
    if (boundingBoxDistance(poly, p) > gap + EPS) continue;
    if (polygonsOverlap(poly, p)) return false;
    if (gap > EPS && polygonsWithinDistance(poly, p, gap)) return false;
  }
  return true;
}

interface PlacementCandidate {
  outline: Polygon;
  rotationDeg: number;
  anchor: Point;
}

// Returns up to `k` candidate placements for `part` on this one sheet — the single best
// (bottom-left-most) position found per rotation, then the best `k` of those across all
// rotations. Trying more than one keeps a downstream beam search from committing to the first
// workable spot the way a plain greedy placer does.
function tryPlacePartTopK(part: PartInstance, sheet: SheetSize, placed: Polygon[], gap: number, k: number): PlacementCandidate[] {
  const anchors = candidateAnchors(sheet, placed);
  const perRotationBest: PlacementCandidate[] = [];

  for (const rot of rotationsFor(part.rotationMode)) {
    const rotated = rotateAroundCentroid(part.outline, rot);
    for (const anchor of anchors) {
      const candidate = placeAtAnchor(rotated, anchor);
      if (fitsOnSheet(candidate, sheet, placed, gap)) {
        // Anchors are sorted bottom-left, so the first fit is already this rotation's best.
        perRotationBest.push({ outline: candidate, rotationDeg: rot, anchor });
        break;
      }
    }
  }

  perRotationBest.sort((a, b) => a.anchor[1] - b.anchor[1] || a.anchor[0] - b.anchor[0]);
  return perRotationBest.slice(0, k);
}

interface SheetPlacement {
  sheetIndex: number;
  candidate: PlacementCandidate;
}

// Same idea as tryPlacePartTopK but across every sheet placed so far. A new sheet is only
// considered as a last resort (no candidate fits on any existing sheet) — never as one of several
// competing options — since beam scoring already penalizes extra sheets heavily, so generating
// "open a new sheet anyway" candidates when an existing one would work is pure wasted work.
function tryPlacePartAcrossSheets(part: PartInstance, sheet: SheetSize, sheetsPlaced: Polygon[][], gap: number, k: number): SheetPlacement[] {
  const results: SheetPlacement[] = [];
  for (let s = 0; s < sheetsPlaced.length; s++) {
    for (const candidate of tryPlacePartTopK(part, sheet, sheetsPlaced[s], gap, k)) {
      results.push({ sheetIndex: s, candidate });
    }
  }
  if (results.length === 0) {
    for (const candidate of tryPlacePartTopK(part, sheet, [], gap, k)) {
      results.push({ sheetIndex: sheetsPlaced.length, candidate });
    }
  }
  results.sort((a, b) => a.candidate.anchor[1] - b.candidate.anchor[1] || a.candidate.anchor[0] - b.candidate.anchor[0]);
  return results.slice(0, k);
}

interface BeamState {
  sheetsPlaced: Polygon[][];
  placements: Placement[];
}

interface StateScore {
  sheetsUsed: number;
  height: number; // total footprint height across all sheets so far — same criterion as isBetter()
}

function scoreState(state: BeamState): StateScore {
  let height = 0;
  for (const polys of state.sheetsPlaced) {
    let maxY = 0;
    for (const poly of polys) {
      const bb = boundingBox(poly);
      if (bb.maxY > maxY) maxY = bb.maxY;
    }
    height += maxY;
  }
  return { sheetsUsed: state.sheetsPlaced.length, height };
}

function scoreIsBetter(a: StateScore, b: StateScore): boolean {
  if (a.sheetsUsed !== b.sheetsUsed) return a.sheetsUsed < b.sheetsUsed;
  return a.height < b.height;
}

// How many partial arrangements are carried forward after each part, and how many placement
// options are considered per part for each of them. Beam search's cost scales with their
// product (roughly BEAM_WIDTH times the cost of the old single-best placer, since each state
// independently searches all rotations/anchors) — kept modest so a full pass through all parts
// stays fast enough for many attempts to still fit in a time budget, on top of this.
const BEAM_WIDTH = 2;
const CANDIDATES_PER_PART = 2;

// Node is single-threaded, and this loop is the only CPU-heavy part of the whole API — with many
// parts (candidate anchors grow with placed count) and free rotation (24 angles tried per part),
// a single attempt can take long enough to block the event loop for that whole stretch, freezing
// every other request the server is handling (including unrelated /health checks) for the same
// stretch — long enough, in practice, to blow past the plugin's own HTTP timeout on a poll that's
// unlucky enough to land during it. Per-part cost isn't uniform (it grows as more parts get
// placed), so yielding is time-based rather than every-N-parts — it checks in regardless of how
// expensive the parts around it turn out to be.
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

// Packs every instance (in the given order) onto one or more sheets using a beam search: for
// each part, every surviving partial arrangement branches into up to CANDIDATES_PER_PART new
// ones (trying that part in several rotations/positions instead of committing to the first
// workable spot), and only the BEAM_WIDTH best-scoring branches carry forward to the next part.
// This mirrors how a person would nest by hand — place the big pieces, try a few spots for the
// next one and see which leaves the tightest result so far, and keep going — rather than a
// single irrevocable greedy placement per part.
export async function packAttempt(sheet: SheetSize, gap: number, instances: PartInstance[]): Promise<PackResult> {
  let beam: BeamState[] = [{ sheetsPlaced: [[]], placements: [] }];
  let lastYieldAt = Date.now();

  for (const part of instances) {
    const next: { state: BeamState; score: StateScore }[] = [];

    for (const state of beam) {
      const options = tryPlacePartAcrossSheets(part, sheet, state.sheetsPlaced, gap, CANDIDATES_PER_PART);
      for (const { sheetIndex, candidate } of options) {
        const sheetsPlaced = state.sheetsPlaced.map((polys, i) => (i === sheetIndex ? polys.concat([candidate.outline]) : polys));
        if (sheetIndex === state.sheetsPlaced.length) sheetsPlaced.push([candidate.outline]);

        const bb = boundingBox(candidate.outline);
        const placements = state.placements.concat([{
          instanceId: part.instanceId,
          partId: part.partId,
          sheetIndex,
          x: bb.minX,
          y: bb.minY,
          rotationDeg: candidate.rotationDeg,
          outline: candidate.outline,
        }]);

        const newState: BeamState = { sheetsPlaced, placements };
        next.push({ state: newState, score: scoreState(newState) });
      }
    }

    if (next.length === 0) {
      throw new NestingError(`Part "${part.partId}" does not fit on an empty sheet at any allowed rotation`);
    }

    next.sort((a, b) => (scoreIsBetter(a.score, b.score) ? -1 : scoreIsBetter(b.score, a.score) ? 1 : 0));
    beam = next.slice(0, BEAM_WIDTH).map((c) => c.state);

    if (Date.now() - lastYieldAt >= YIELD_INTERVAL_MS) {
      lastYieldAt = Date.now();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  let best = beam[0];
  let bestScore = scoreState(best);
  for (const state of beam.slice(1)) {
    const score = scoreState(state);
    if (scoreIsBetter(score, bestScore)) {
      best = state;
      bestScore = score;
    }
  }

  const sheetFootprints = computeFootprints(best.sheetsPlaced);
  const usedArea = instances.reduce((sum, p) => sum + netArea(p.outline, p.holes), 0);
  const footprintArea = sheetFootprints.reduce((sum, f) => sum + f.width * f.height, 0);

  return {
    sheetsUsed: best.sheetsPlaced.length,
    placements: best.placements,
    sheetFootprints,
    utilizationPct: footprintArea > 0 ? (usedArea / footprintArea) * 100 : 0,
  };
}
