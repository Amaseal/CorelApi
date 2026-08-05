import { packAttempt } from './packer';
import { PartInstance } from './types';
import { Polygon } from './geometry';

function irregularShape(seed: number): Polygon {
  const w = 150 + (seed % 5) * 20;
  const h = 400 + (seed % 7) * 30;
  const pts: Polygon = [];
  const n = 55;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const wobble = 1 + 0.08 * Math.sin(t * 5 + seed);
    const x = (w / 2) * (1 + Math.cos(t)) * wobble;
    const y = (h / 2) * (1 + Math.sin(t)) * wobble;
    pts.push([x, y]);
  }
  return pts;
}

async function run(gap: number) {
  const instances: PartInstance[] = [];
  for (let i = 0; i < 17; i++) {
    instances.push({
      instanceId: `p${i}#0`,
      partId: `p${i}`,
      outline: irregularShape(i),
      holes: [],
      rotationMode: 'free',
    });
  }
  const start = Date.now();
  const result = await packAttempt({ width: 1320, height: 1500 }, gap, instances);
  const elapsed = Date.now() - start;
  console.log(`gap=${gap}: ${elapsed}ms, sheetsUsed=${result.sheetsUsed}, footprint=${JSON.stringify(result.sheetFootprints)}`);
}

async function main() {
  await run(0);
  await run(3);
}

main();
