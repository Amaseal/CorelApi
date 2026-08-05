import { EPS, Point, Polygon, boundingBox, boundingBoxDistance, netArea, placeAtAnchor, polygonMinDistance, polygonsOverlap, rotateAroundCentroid } from './geometry';
import { NestingError, PackResult, PartInstance, Placement, RotationMode, SheetFootprint, SheetSize } from './types';

const FREE_ROTATION_STEP_DEG = 15;

function rotationsFor(mode: RotationMode): number[] {
  if (mode === 'locked') return [0];
  if (mode === 'step90') return [0, 90, 180, 270];
  const angles: number[] = [];
  for (let a = 0; a < 360; a += FREE_ROTATION_STEP_DEG) angles.push(a);
  return angles;
}

// Candidate bottom-left anchor points: sheet origin plus every corner of every already-placed
// part's bounding box. This is a cheap stand-in for a full no-fit-polygon touching-point search —
// it keeps parts packed tight against sheet edges and each other without computing Minkowski sums.
function candidateAnchors(sheet: SheetSize, placed: Polygon[]): Point[] {
  const xs = new Set<number>([0]);
  const ys = new Set<number>([0]);
  for (const p of placed) {
    const bb = boundingBox(p);
    xs.add(bb.minX);
    xs.add(bb.maxX);
    ys.add(bb.minY);
    ys.add(bb.maxY);
  }
  const anchors: Point[] = [];
  for (const y of ys) {
    for (const x of xs) {
      if (x >= -EPS && y >= -EPS && x <= sheet.width + EPS && y <= sheet.height + EPS) {
        anchors.push([x, y]);
      }
    }
  }
  anchors.sort((p1, p2) => p1[1] - p2[1] || p1[0] - p2[0]);
  return anchors;
}

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
    if (gap > EPS && polygonMinDistance(poly, p) < gap - EPS) return false;
  }
  return true;
}

interface PlacementCandidate {
  outline: Polygon;
  rotationDeg: number;
  anchor: Point;
}

function tryPlacePart(part: PartInstance, sheet: SheetSize, placed: Polygon[], gap: number): PlacementCandidate | null {
  const anchors = candidateAnchors(sheet, placed);
  let best: PlacementCandidate | null = null;

  for (const rot of rotationsFor(part.rotationMode)) {
    const rotated = rotateAroundCentroid(part.outline, rot);
    for (const anchor of anchors) {
      const candidate = placeAtAnchor(rotated, anchor);
      if (fitsOnSheet(candidate, sheet, placed, gap)) {
        // Anchors are sorted bottom-left, so the first fit is already this rotation's best.
        if (!best || anchor[1] < best.anchor[1] - EPS || (Math.abs(anchor[1] - best.anchor[1]) <= EPS && anchor[0] < best.anchor[0])) {
          best = { outline: candidate, rotationDeg: rot, anchor };
        }
        break;
      }
    }
  }
  return best;
}

// Packs every instance (in the given order) onto one or more sheets using greedy bottom-left-fill.
// A part that doesn't fit on any sheet placed so far opens a new sheet; earlier sheets are tried
// first so gaps left by earlier, larger parts can still be filled by later, smaller ones.
//
// Node is single-threaded, and this loop is the only CPU-heavy part of the whole API — with many
// parts (candidate anchors grow with placed count) and free rotation (24 angles tried per part),
// a single attempt can take long enough to block the event loop for that whole stretch, freezing
// every other request the server is handling (including unrelated /health checks) for the same
// stretch — long enough, in practice, to blow past the plugin's own HTTP timeout on a poll that's
// unlucky enough to land during it. Per-part cost isn't uniform (it grows as more parts get
// placed), so yielding is time-based rather than every-N-parts — it checks in regardless of how
// expensive the parts around it turn out to be.
const YIELD_INTERVAL_MS = 100;

export async function packAttempt(sheet: SheetSize, gap: number, instances: PartInstance[]): Promise<PackResult> {
  const sheetsPlaced: Polygon[][] = [[]];
  const placements: Placement[] = [];
  let lastYieldAt = Date.now();

  for (let idx = 0; idx < instances.length; idx++) {
    const part = instances[idx];
    let sheetIndex = -1;
    let placement: PlacementCandidate | null = null;

    for (let i = 0; i < sheetsPlaced.length && !placement; i++) {
      placement = tryPlacePart(part, sheet, sheetsPlaced[i], gap);
      if (placement) sheetIndex = i;
    }

    if (!placement) {
      sheetsPlaced.push([]);
      sheetIndex = sheetsPlaced.length - 1;
      placement = tryPlacePart(part, sheet, sheetsPlaced[sheetIndex], gap);
      if (!placement) {
        throw new NestingError(`Part "${part.partId}" does not fit on an empty sheet at any allowed rotation`);
      }
    }

    sheetsPlaced[sheetIndex].push(placement.outline);
    const bb = boundingBox(placement.outline);
    placements.push({
      instanceId: part.instanceId,
      partId: part.partId,
      sheetIndex,
      x: bb.minX,
      y: bb.minY,
      rotationDeg: placement.rotationDeg,
      outline: placement.outline,
    });

    if (Date.now() - lastYieldAt >= YIELD_INTERVAL_MS) {
      lastYieldAt = Date.now();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  // Actual footprint per sheet — the tight bounding box of what got placed there, not the
  // configured sheet size (which is only an upper bound, e.g. a generous roll-length allowance).
  const sheetFootprints: SheetFootprint[] = sheetsPlaced.map((polys) => {
    let maxX = 0, maxY = 0;
    for (const poly of polys) {
      const bb = boundingBox(poly);
      if (bb.maxX > maxX) maxX = bb.maxX;
      if (bb.maxY > maxY) maxY = bb.maxY;
    }
    return { width: maxX, height: maxY };
  });

  const usedArea = instances.reduce((sum, p) => sum + netArea(p.outline, p.holes), 0);
  const footprintArea = sheetFootprints.reduce((sum, f) => sum + f.width * f.height, 0);

  return {
    sheetsUsed: sheetsPlaced.length,
    placements,
    sheetFootprints,
    utilizationPct: footprintArea > 0 ? (usedArea / footprintArea) * 100 : 0,
  };
}
