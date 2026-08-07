import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Polygon, boundingBox, polygonArea } from './geometry';
import { initClipper, nfpLoops, unionPolygons } from './nfp';

before(async () => {
  await initClipper();
});

describe('nfpLoops', () => {
  it('computes the exact no-fit-polygon for two axis-aligned squares', () => {
    // Minkowski difference of a 10x10 obstacle and a 4x4 moving shape (both anchored at their own
    // bbox-min corner, i.e. already normalized) is exactly the 14x14 square spanning
    // (-4,-4) to (10,10): the moving square's own corner can range that far before it stops
    // touching the obstacle. A clean, hand-verifiable case for validating the real Clipper2 API
    // (see this module's other functions' history of wrong assumed argument order/behavior).
    const obstacle: Polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const moving: Polygon = [[0, 0], [4, 0], [4, 4], [0, 4]];

    const loops = nfpLoops(obstacle, moving, 0);
    assert.equal(loops.length, 1);
    const bb = boundingBox(loops[0]);
    assert.ok(Math.abs(bb.minX - -4) < 1e-6);
    assert.ok(Math.abs(bb.minY - -4) < 1e-6);
    assert.ok(Math.abs(bb.maxX - 10) < 1e-6);
    assert.ok(Math.abs(bb.maxY - 10) < 1e-6);
    assert.ok(Math.abs(polygonArea(loops[0]) - 196) < 1e-3);
  });
});

describe('unionPolygons', () => {
  it('merges two overlapping squares into a single loop with the correct combined area', () => {
    const a: Polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const b: Polygon = [[5, 5], [15, 5], [15, 15], [5, 15]];
    // 100 + 100 - 25 (the 5x5 overlap) = 175
    const result = unionPolygons([a, b]);
    assert.equal(result.length, 1);
    assert.ok(Math.abs(polygonArea(result[0]) - 175) < 1e-3);
  });

  it('keeps disjoint loops separate', () => {
    const a: Polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const b: Polygon = [[100, 100], [110, 100], [110, 110], [100, 110]];
    const result = unionPolygons([a, b]);
    assert.equal(result.length, 2);
    const totalArea = result.reduce((sum, loop) => sum + polygonArea(loop), 0);
    assert.ok(Math.abs(totalArea - 200) < 1e-3);
  });

  it('returns the single input unchanged (no-op) rather than calling into Clipper', () => {
    const a: Polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const result = unionPolygons([a]);
    assert.equal(result.length, 1);
    assert.ok(Math.abs(polygonArea(result[0]) - 100) < 1e-6);
  });
});
