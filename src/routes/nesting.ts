import { Router } from 'express';
import { Point, Polygon, simplifyToPointBudget } from '../nesting/geometry';
import { cancelJob, createJob, getJob, NestJobConfig } from '../nesting/jobs';
import { NestPart } from '../nesting/nest';
import { RotationMode } from '../nesting/types';

const router = Router();

const ROTATION_MODES: RotationMode[] = ['free', 'locked', 'step90'];

// A true safety net for pathological inputs (an unexpectedly detailed outline, or a client that
// sent one unsimplified) — NOT a routine transformation. The plugin already lets the operator
// control the fidelity/speed tradeoff directly via its own "Outline detail" tolerance (typically
// landing around 40-60 points/part); silently re-simplifying everything down to a much lower
// target here overrides that choice and can visibly distort the contour features (notches,
// curves) that let parts actually nest tightly — this was tried at 40 and made real jobs pack
// noticeably worse. Set high enough that it essentially never fires on a normally-simplified part.
const MAX_OUTLINE_POINTS = 200;

function parsePolygon(raw: unknown, label: string): Polygon {
  if (!Array.isArray(raw) || raw.length < 3) throw new Error(`${label} must be an array of at least 3 [x,y] points`);
  return raw.map((pt: unknown, i: number): Point => {
    if (!Array.isArray(pt) || pt.length !== 2 || typeof pt[0] !== 'number' || typeof pt[1] !== 'number') {
      throw new Error(`${label}[${i}] must be a [x, y] number pair`);
    }
    return [pt[0], pt[1]];
  });
}

function parsePart(raw: any, i: number): NestPart {
  if (!raw || typeof raw.id !== 'string' || !raw.id) throw new Error(`parts[${i}].id is required`);
  const quantity = Number(raw.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`parts[${i}].quantity must be a positive integer`);
  if (!ROTATION_MODES.includes(raw.rotationMode)) {
    throw new Error(`parts[${i}].rotationMode must be one of ${ROTATION_MODES.join(', ')}`);
  }
  const outline = simplifyToPointBudget(parsePolygon(raw.outline, `parts[${i}].outline`), MAX_OUTLINE_POINTS, 0.1);
  const holes = Array.isArray(raw.holes)
    ? raw.holes.map((h: unknown, hi: number) => simplifyToPointBudget(parsePolygon(h, `parts[${i}].holes[${hi}]`), MAX_OUTLINE_POINTS, 0.1))
    : [];
  return { partId: raw.id, quantity, outline, holes, rotationMode: raw.rotationMode };
}

function parseConfig(body: any): NestJobConfig {
  const sheet = body.sheet;
  if (!sheet || typeof sheet.widthMm !== 'number' || typeof sheet.heightMm !== 'number' || sheet.widthMm <= 0 || sheet.heightMm <= 0) {
    throw new Error('sheet.widthMm and sheet.heightMm must be positive numbers');
  }
  const gap = typeof body.gapMm === 'number' && body.gapMm >= 0 ? body.gapMm : 0;
  const timeBudgetSec = typeof body.timeBudgetSec === 'number' && body.timeBudgetSec > 0 ? body.timeBudgetSec : undefined;
  const maxIterations = typeof body.maxIterations === 'number' && body.maxIterations > 0 ? Math.floor(body.maxIterations) : undefined;
  if (!timeBudgetSec && !maxIterations) throw new Error('Provide either timeBudgetSec or maxIterations');
  if (!Array.isArray(body.parts) || body.parts.length === 0) throw new Error('parts must be a non-empty array');

  const parts = body.parts.map(parsePart);
  return {
    sheet: { width: sheet.widthMm, height: sheet.heightMm },
    gap,
    budget: { timeBudgetSec, maxIterations },
    parts,
  };
}

// POST /nesting/jobs — starts an async nesting job, returns its id immediately.
router.post('/jobs', (req, res) => {
  try {
    const config = parseConfig(req.body);
    const jobId = createJob(config);
    res.status(201).json({ jobId });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /nesting/jobs/:id — poll status/progress while a job runs.
router.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({
    status: job.status,
    elapsedSec: job.elapsedMs / 1000,
    iterationsTried: job.iterationsTried,
    bestSheetsUsed: job.best ? job.best.sheetsUsed : null,
    bestUtilizationPct: job.best ? job.best.utilizationPct : null,
    error: job.error,
  });
});

// GET /nesting/jobs/:id/result — final placements, once done (or the best-so-far on error/cancel).
router.get('/jobs/:id/result', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) { res.status(404).json({ error: 'Not found' }); return; }
  if (job.status !== 'done' && job.status !== 'error') {
    res.status(409).json({ error: 'Job not finished', status: job.status });
    return;
  }
  if (!job.best) {
    res.status(500).json({ error: job.error ?? 'Nesting failed' });
    return;
  }
  const best = job.best;
  res.json({
    sheetsUsed: best.sheetsUsed,
    utilizationPct: best.utilizationPct,
    sheets: Array.from({ length: best.sheetsUsed }, (_, sheetIndex) => ({
      index: sheetIndex,
      footprintWidth: best.sheetFootprints[sheetIndex].width,
      footprintHeight: best.sheetFootprints[sheetIndex].height,
      placements: best.placements
        .filter((p) => p.sheetIndex === sheetIndex)
        .map((p) => ({ instanceId: p.instanceId, partId: p.partId, x: p.x, y: p.y, rotationDeg: p.rotationDeg })),
    })),
  });
});

// DELETE /nesting/jobs/:id — cancel a running job; it finalizes with the best result found so far.
router.delete('/jobs/:id', (req, res) => {
  const ok = cancelJob(req.params.id);
  if (!ok) { res.status(404).json({ error: 'Not found' }); return; }
  res.sendStatus(204);
});

export default router;
