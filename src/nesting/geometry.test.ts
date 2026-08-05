import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Polygon,
  boundingBox,
  pointInPolygon,
  polygonArea,
  polygonMinDistance,
  polygonsOverlap,
  rotateAroundCentroid,
  simplifyToPointBudget,
} from './geometry';

describe('polygonArea', () => {
  it('computes the area of a rectangle', () => {
    const rect: Polygon = [[0, 0], [10, 0], [10, 5], [0, 5]];
    assert.equal(polygonArea(rect), 50);
  });

  it('computes the area of a concave L-shape', () => {
    const L: Polygon = [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]];
    assert.equal(polygonArea(L), 75); // 10x10 square minus a 5x5 corner
  });
});

describe('pointInPolygon', () => {
  it('distinguishes inside from outside a square', () => {
    const sq: Polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    assert.equal(pointInPolygon([5, 5], sq), true);
    assert.equal(pointInPolygon([15, 5], sq), false);
  });
});

describe('polygonsOverlap', () => {
  it('detects overlapping rectangles', () => {
    const a: Polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const b: Polygon = [[5, 5], [15, 5], [15, 15], [5, 15]];
    assert.equal(polygonsOverlap(a, b), true);
  });

  it('does not flag disjoint rectangles', () => {
    const a: Polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const b: Polygon = [[20, 20], [30, 20], [30, 30], [20, 30]];
    assert.equal(polygonsOverlap(a, b), false);
  });

  it('does not flag rectangles that merely share an edge', () => {
    const a: Polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const b: Polygon = [[10, 0], [20, 0], [20, 10], [10, 10]];
    assert.equal(polygonsOverlap(a, b), false);
  });

  it('detects one polygon fully containing another', () => {
    const outer: Polygon = [[0, 0], [20, 0], [20, 20], [0, 20]];
    const inner: Polygon = [[5, 5], [15, 5], [15, 15], [5, 15]];
    assert.equal(polygonsOverlap(outer, inner), true);
  });

  it('detects overlap between concave shapes', () => {
    const L: Polygon = [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]];
    const intruder: Polygon = [[7, 7], [12, 7], [12, 12], [7, 12]]; // sits in the L's notch corner
    assert.equal(polygonsOverlap(L, intruder), false);
    const intruder2: Polygon = [[2, 2], [8, 2], [8, 8], [2, 8]]; // overlaps the L's solid body
    assert.equal(polygonsOverlap(L, intruder2), true);
  });
});

describe('polygonMinDistance', () => {
  it('returns 0 for touching rectangles', () => {
    const a: Polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const b: Polygon = [[10, 0], [20, 0], [20, 10], [10, 10]];
    assert.equal(polygonMinDistance(a, b), 0);
  });

  it('returns the true gap between separated rectangles', () => {
    const a: Polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const b: Polygon = [[15, 0], [25, 0], [25, 10], [15, 10]];
    assert.equal(polygonMinDistance(a, b), 5);
  });

  it('returns 0 for overlapping polygons', () => {
    const a: Polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const b: Polygon = [[5, 5], [15, 5], [15, 15], [5, 15]];
    assert.equal(polygonMinDistance(a, b), 0);
  });
});

describe('rotateAroundCentroid', () => {
  it('preserves area and bounding box size for a 90-degree rotation of a square', () => {
    const sq: Polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const rotated = rotateAroundCentroid(sq, 90);
    assert.ok(Math.abs(polygonArea(rotated) - 100) < 1e-6);
    const bb = boundingBox(rotated);
    assert.ok(Math.abs(bb.width - 10) < 1e-6);
    assert.ok(Math.abs(bb.height - 10) < 1e-6);
  });
});

describe('simplifyToPointBudget', () => {
  it('leaves a polygon untouched when it is already within budget', () => {
    // Regression guard: a server-side "safety net" cap that fires on normally-sized, already-
    // simplified parts silently overrides the client's own fidelity choice and can distort the
    // contour features (notches, curves) that let parts nest tightly — this happened for real
    // with a too-low cap and visibly made production jobs pack worse.
    const rect: Polygon = [[0, 0], [10, 0], [10, 5], [0, 5]];
    const result = simplifyToPointBudget(rect, 200, 0.1);
    assert.deepEqual(result, rect);
  });

  it('keeps the simplified shape close to the original when it does need to simplify', () => {
    // A circle approximated with 200 points, simplified down to a 30-point budget, should still
    // look roughly like the same circle — not a wildly different shape or a degenerate result.
    const n = 200, r = 50;
    const circle: Polygon = Array.from({ length: n }, (_, i) => {
      const t = (i / n) * Math.PI * 2;
      return [r * Math.cos(t), r * Math.sin(t)] as [number, number];
    });

    const result = simplifyToPointBudget(circle, 30, 0.1);
    assert.ok(result.length <= 30, `expected at most 30 points, got ${result.length}`);
    assert.ok(result.length >= 3, `expected a valid polygon, got ${result.length} points`);

    const originalArea = polygonArea(circle);
    const simplifiedArea = polygonArea(result);
    const areaChangePct = Math.abs(simplifiedArea - originalArea) / originalArea * 100;
    assert.ok(areaChangePct < 10, `simplification changed area by ${areaChangePct.toFixed(1)}%, expected < 10%`);
  });
});
