import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Polygon, polygonMinDistance } from './geometry';
import { runNesting } from './nest';

const rect = (w: number, h: number): Polygon => [[0, 0], [w, 0], [w, h], [0, h]];

const noProgress = () => {};
const neverCancelled = () => false;

describe('runNesting', () => {
  it('packs every instance without any overlap or gap violation', async () => {
    const parts = [{ partId: 'a', outline: rect(20, 10), holes: [], rotationMode: 'locked' as const, quantity: 6 }];
    const result = await runNesting({ width: 100, height: 100 }, 2, parts, { maxIterations: 5 }, noProgress, neverCancelled);

    assert.equal(result.placements.length, 6);
    for (let i = 0; i < result.placements.length; i++) {
      for (let j = i + 1; j < result.placements.length; j++) {
        if (result.placements[i].sheetIndex !== result.placements[j].sheetIndex) continue;
        const d = polygonMinDistance(result.placements[i].outline, result.placements[j].outline);
        assert.ok(d >= 2 - 1e-6, `placements ${i} and ${j} are closer than the 2mm gap: ${d}`);
      }
    }
  });

  it('spills onto additional sheets when parts do not all fit on one', async () => {
    const parts = [{ partId: 'a', outline: rect(60, 60), holes: [], rotationMode: 'locked' as const, quantity: 3 }];
    const result = await runNesting({ width: 100, height: 100 }, 0, parts, { maxIterations: 1 }, noProgress, neverCancelled);
    assert.ok(result.sheetsUsed >= 2, `expected at least 2 sheets, got ${result.sheetsUsed}`);
    assert.equal(result.placements.length, 3);
  });

  it('rejects a part larger than the sheet', async () => {
    const parts = [{ partId: 'a', outline: rect(200, 200), holes: [], rotationMode: 'locked' as const, quantity: 1 }];
    await assert.rejects(() => runNesting({ width: 100, height: 100 }, 0, parts, { maxIterations: 1 }, noProgress, neverCancelled));
  });

  it('respects a locked rotation mode (keeps original orientation)', async () => {
    // A 90x10 part on a 100x95 sheet only fits unrotated; if rotation were allowed it could also
    // stand on end, so this exercises that 'locked' truly forbids that.
    const parts = [{ partId: 'a', outline: rect(90, 10), holes: [], rotationMode: 'locked' as const, quantity: 1 }];
    const result = await runNesting({ width: 100, height: 95 }, 0, parts, { maxIterations: 1 }, noProgress, neverCancelled);
    assert.equal(result.placements[0].rotationDeg, 0);
  });

  it('scores utilization against the actual placed footprint, not the nominal sheet size', async () => {
    // Regression test: utilization used to be usedArea / (sheetsUsed * configuredSheetArea).
    // For a single sheet, both of those are constant across every attempt regardless of how
    // tightly packed the arrangement actually is, which made the optimizer look "stuck" — it
    // could never recognize a genuinely better arrangement because the score never moved.
    const parts = [{ partId: 'a', outline: rect(10, 10), holes: [], rotationMode: 'locked' as const, quantity: 1 }];
    const result = await runNesting({ width: 500, height: 500 }, 0, parts, { maxIterations: 1 }, noProgress, neverCancelled);

    assert.ok(result.sheetFootprints[0].width <= 10 + 1e-6, `footprint width should track the part, got ${result.sheetFootprints[0].width}`);
    assert.ok(result.sheetFootprints[0].height <= 10 + 1e-6, `footprint height should track the part, got ${result.sheetFootprints[0].height}`);
    // Against the tight 10x10 footprint this should be ~100%; against the nominal 500x500 sheet
    // it would be ~0.04% — a result in the high range proves it's scored against the footprint.
    assert.ok(result.utilizationPct > 90, `expected utilization scored against the footprint, got ${result.utilizationPct}%`);
  });

  it('reports progress and honors cancellation', async () => {
    const parts = [{ partId: 'a', outline: rect(10, 10), holes: [], rotationMode: 'free' as const, quantity: 4 }];
    let calls = 0;
    let cancelAfter = 2;
    const result = await runNesting(
      { width: 50, height: 50 },
      1,
      parts,
      { maxIterations: 1000 },
      () => { calls++; },
      () => calls >= cancelAfter,
    );
    assert.ok(calls >= cancelAfter);
    assert.ok(result.placements.length === 4);
  });
});
