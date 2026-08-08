// Real-world nesting benchmark: 16 actual sticker shapes (testdata/test_stickers.svg), already
// arranged by e-cut into its best achieved layout. The SVG's viewBox exactly matches its physical
// size, so that layout's real footprint is a genuine "beat this" target — not a synthetic guess.
//
// Run with: npx tsx src/nesting/benchmark.ts
import { readFileSync } from 'fs';
import { join } from 'path';
import { svgPathProperties } from 'svg-path-properties';
import { Polygon, boundingBox, polygonArea, simplifyToPointBudget } from './geometry';
import { initClipper } from './nfp';
import { runNesting } from './nest';
import { packAttempt } from './packer';
import { PartInstance, RotationMode } from './types';

const SVG_PATH = join(__dirname, '..', '..', 'testdata', 'test_stickers.svg');

function extractPathStrings(svg: string): string[] {
  return [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
}

function readMmAttr(svg: string, name: string): number {
  const m = svg.match(new RegExp(`${name}="([\\d.]+)mm"`));
  if (!m) throw new Error(`Could not find ${name}="...mm" in SVG`);
  return parseFloat(m[1]);
}

function readViewBoxWidth(svg: string): number {
  const m = svg.match(/viewBox="[\d.]+\s+[\d.]+\s+([\d.]+)\s+[\d.]+"/);
  if (!m) throw new Error('Could not find viewBox in SVG');
  return parseFloat(m[1]);
}

// Samples a path densely at regular arc-length intervals to flatten its Bezier curves into a
// polygon (the same kind of flattening step the C# plugin does from CorelDRAW's own curve data,
// just from SVG path data instead of Curve.SubPaths), then simplifies down to a realistic point
// count. Real production outlines never reach the nesting API at raw curve-sample density — the
// C# plugin's own "Outline detail" step (default 0.3mm tolerance) already simplifies to roughly
// 40-60 points before sending. Feeding this benchmark raw ~300-point samples was measured to make
// a single attempt take far longer than any real job would — not a genuine regression, just an
// unrepresentative fixture.
function flattenPath(d: string, scale: number): Polygon {
  const props = new svgPathProperties(d);
  const totalLength = props.getTotalLength();
  const numSamples = Math.max(50, Math.min(400, Math.round(totalLength / 10)));
  const dense: Polygon = [];
  for (let i = 0; i < numSamples; i++) {
    const p = props.getPointAtLength((i / numSamples) * totalLength);
    dense.push([p.x * scale, p.y * scale]);
  }
  return simplifyToPointBudget(dense, 60, 0.1);
}

async function main() {
  const svg = readFileSync(SVG_PATH, 'utf-8');
  const widthMm = readMmAttr(svg, 'width');
  const heightMm = readMmAttr(svg, 'height');
  const viewBoxWidth = readViewBoxWidth(svg);
  const scale = widthMm / viewBoxWidth;

  const pathStrings = extractPathStrings(svg);
  const stickers = pathStrings.map((d) => flattenPath(d, scale));

  console.log(`Loaded ${stickers.length} real sticker shapes from test_stickers.svg`);
  console.log(`e-cut's achieved footprint: ${widthMm.toFixed(2)} x ${heightMm.toFixed(2)} mm (this is the number to beat)`);
  console.log(`Point counts: ${stickers.map((s) => s.length).join(', ')}`);

  const totalArea = stickers.reduce((sum, s) => sum + polygonArea(s), 0);
  const sheetArea = widthMm * heightMm;
  console.log(`Total sticker area: ${(totalArea / 1e6).toFixed(3)} m^2, e-cut sheet area: ${(sheetArea / 1e6).toFixed(3)} m^2 (${((totalArea / sheetArea) * 100).toFixed(1)}% theoretical max utilization)`);
  console.log('Bounding boxes (w x h mm):');
  for (let i = 0; i < stickers.length; i++) {
    const bb = boundingBox(stickers[i]);
    console.log(`  sticker${i}: ${bb.width.toFixed(1)} x ${bb.height.toFixed(1)} (area ${(polygonArea(stickers[i]) / 1000).toFixed(1)} cm^2)`);
  }

  await initClipper();
  console.log('Clipper2 WASM loaded.');

  const rotationMode: RotationMode = (process.argv.find((a) => ['free', 'locked', 'step90'].includes(a)) as RotationMode) ?? 'free';
  console.log(`Rotation mode: ${rotationMode}`);
  const parts = stickers.map((outline, i) => ({
    partId: `sticker${i}`,
    outline,
    holes: [],
    rotationMode,
    quantity: 1,
  }));

  if (process.argv.includes('--single')) {
    console.log('Timing a single packAttempt (isolated, no multi-attempt loop)...');
    const instances: PartInstance[] = parts.map((p) => ({
      instanceId: `${p.partId}#0`, partId: p.partId, outline: p.outline, holes: p.holes, rotationMode: p.rotationMode, rotationDeg: 0,
    }));
    // Largest-first order, matching the GA's "adam" baseline, so this traces the same
    // deterministic attempt the search starts from.
    instances.sort((a, b) => {
      const areaOf = (p: PartInstance) => boundingBox(p.outline).width * boundingBox(p.outline).height;
      return areaOf(b) - areaOf(a);
    });
    const t0 = Date.now();
    const single = await packAttempt({ width: widthMm, height: heightMm * 3 }, 0, instances);
    console.log(`Single packAttempt: ${((Date.now() - t0) / 1000).toFixed(1)}s, sheetsUsed=${single.sheetsUsed}, footprint=${JSON.stringify(single.sheetFootprints)}`);
    console.log('\nPlacement trace (order placed):');
    for (const p of single.placements) {
      console.log(`  ${p.partId}: sheet ${p.sheetIndex}, pos (${p.x.toFixed(1)}, ${p.y.toFixed(1)}), rot ${p.rotationDeg}`);
    }
    return;
  }

  const budgetSec = Number(process.argv.find((a) => /^\d+$/.test(a))) || 90;
  const immigrantsArg = process.argv.find((a) => /^--immigrants=\d+$/.test(a));
  const randomImmigrantsPerGen = immigrantsArg ? Number(immigrantsArg.split('=')[1]) : undefined;
  console.log(`Running nest (gap=0, free rotation, ${budgetSec}s budget${randomImmigrantsPerGen !== undefined ? `, randomImmigrantsPerGen=${randomImmigrantsPerGen}` : ''})...`);

  const formatFootprints = (r: { sheetsUsed: number; sheetFootprints: { width: number; height: number }[] }) =>
    `${r.sheetsUsed} sheet(s), footprint ${r.sheetFootprints.map((f) => `${f.width.toFixed(1)}x${f.height.toFixed(1)}`).join(', ')}`;

  const start = Date.now();
  const result = await runNesting(
    { width: widthMm, height: heightMm * 3 }, // generous height allowance, like a roll
    0,
    parts,
    { timeBudgetSec: budgetSec, randomImmigrantsPerGen },
    (iterations, current, best) => {
      const currentInfo = current ? formatFootprints(current) : 'no fit';
      const bestInfo = best ? formatFootprints(best) : 'no valid arrangement yet';
      console.log(
        `  attempt ${iterations}, ${((Date.now() - start) / 1000).toFixed(1)}s — this try: ${currentInfo} | best so far: ${bestInfo}`
      );
    },
    () => false,
  );

  const elapsed = (Date.now() - start) / 1000;
  console.log('\n=== RESULT ===');
  console.log(`Elapsed: ${elapsed.toFixed(1)}s`);
  console.log(`Sheets used: ${result.sheetsUsed}`);
  for (const f of result.sheetFootprints) {
    console.log(`  Sheet footprint: ${f.width.toFixed(2)} x ${f.height.toFixed(2)} mm`);
  }
  console.log(`e-cut benchmark: ${widthMm.toFixed(2)} x ${heightMm.toFixed(2)} mm`);
  const ourHeight = result.sheetFootprints[0]?.height ?? 0;
  const diff = ourHeight - heightMm;
  console.log(`Height difference vs e-cut: ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}mm (${((diff / heightMm) * 100).toFixed(1)}%)`);

  console.log('\nBest individual placement trace (sorted by y):');
  const sortedPlacements = [...result.placements].sort((a, b) => a.y - b.y);
  for (const p of sortedPlacements) {
    const bb = boundingBox(p.outline);
    console.log(`  ${p.partId}: pos (${p.x.toFixed(1)}, ${p.y.toFixed(1)}), rot ${p.rotationDeg}, bbox ${bb.width.toFixed(1)}x${bb.height.toFixed(1)}, top=${(p.y + bb.height).toFixed(1)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
