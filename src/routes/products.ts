import { Router } from 'express';
import { asc, eq, and, sql } from 'drizzle-orm';
import { db } from '../db';
import { products, productParts, productSizes, sizeLibrary } from '../db/schema';

const router = Router();

// ── Products ──────────────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  try {
    const rows = await db
      .select({ id: products.id, name: products.name })
      .from(products)
      .orderBy(asc(products.sortOrder), asc(products.name));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post('/', async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const [row] = await db
      .insert(products)
      .values({ name: name.trim() })
      .returning({ id: products.id, name: products.name });
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await db.delete(products).where(eq(products.id, Number(req.params.id)));
    res.sendStatus(204);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Parts ─────────────────────────────────────────────────────────────────────

router.get('/:id/parts', async (req, res) => {
  try {
    const rows = await db
      .select({ partName: productParts.partName })
      .from(productParts)
      .where(eq(productParts.productId, Number(req.params.id)))
      .orderBy(asc(productParts.sortOrder), asc(productParts.partName));
    res.json(rows.map(r => r.partName));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post('/:id/parts', async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    await db
      .insert(productParts)
      .values({ productId: Number(req.params.id), partName: name.trim() })
      .onConflictDoNothing();
    res.sendStatus(201);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.delete('/:id/parts/:name', async (req, res) => {
  const productId = Number(req.params.id);
  const partName  = req.params.name;
  try {
    // Cascade: remove library entries for this part first
    await db.delete(sizeLibrary).where(
      and(eq(sizeLibrary.productId, productId), eq(sizeLibrary.partName, partName))
    );
    await db.delete(productParts).where(
      and(eq(productParts.productId, productId), eq(productParts.partName, partName))
    );
    res.sendStatus(204);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Sizes ─────────────────────────────────────────────────────────────────────

router.get('/:id/sizes', async (req, res) => {
  try {
    const rows = await db
      .select({ sizeLabel: productSizes.sizeLabel })
      .from(productSizes)
      .where(eq(productSizes.productId, Number(req.params.id)))
      .orderBy(asc(productSizes.sortOrder), asc(productSizes.sizeLabel));
    res.json(rows.map(r => r.sizeLabel));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post('/:id/sizes', async (req, res) => {
  const { label } = req.body as { label?: string };
  if (!label?.trim()) { res.status(400).json({ error: 'label required' }); return; }
  try {
    await db
      .insert(productSizes)
      .values({ productId: Number(req.params.id), sizeLabel: label.trim() })
      .onConflictDoNothing();
    res.sendStatus(201);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.delete('/:id/sizes/:label', async (req, res) => {
  const productId = Number(req.params.id);
  const label     = req.params.label;
  try {
    await db.delete(sizeLibrary).where(
      and(eq(sizeLibrary.productId, productId), eq(sizeLibrary.sizeLabel, label))
    );
    await db.delete(productSizes).where(
      and(eq(productSizes.productId, productId), eq(productSizes.sizeLabel, label))
    );
    res.sendStatus(204);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Library (scoped to product) ───────────────────────────────────────────────

router.get('/:id/library', async (req, res) => {
  try {
    const rows = await db
      .select({
        id:         sizeLibrary.id,
        sizeLabel:  sizeLibrary.sizeLabel,
        partName:   sizeLibrary.partName,
        capturedAt: sizeLibrary.capturedAt,
        hasSvg:     sizeLibrary.svgContent,
      })
      .from(sizeLibrary)
      .where(eq(sizeLibrary.productId, Number(req.params.id)))
      .orderBy(asc(sizeLibrary.partName), asc(sizeLibrary.sizeLabel));

    res.json(rows.map(r => ({
      id:         r.id,
      sizeLabel:  r.sizeLabel,
      partName:   r.partName,
      capturedAt: r.capturedAt,
      hasSvg:     r.hasSvg.length > 0,
    })));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post('/:id/library', async (req, res) => {
  const { size, part, svg } = req.body as { size?: string; part?: string; svg?: string };
  if (!size || !part || !svg) { res.status(400).json({ error: 'size, part, svg required' }); return; }
  try {
    await db
      .insert(sizeLibrary)
      .values({ productId: Number(req.params.id), sizeLabel: size, partName: part, svgContent: svg })
      .onConflictDoUpdate({
        target: [sizeLibrary.productId, sizeLibrary.sizeLabel, sizeLibrary.partName],
        set: { svgContent: sql`excluded.svg_content`, capturedAt: sql`NOW()` },
      });
    res.sendStatus(201);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.get('/:id/part-shapes', async (req, res) => {
  const part = req.query.part as string | undefined;
  if (!part) { res.status(400).json({ error: 'part query param required' }); return; }
  try {
    const rows = await db
      .select({
        id:         sizeLibrary.id,
        sizeLabel:  sizeLibrary.sizeLabel,
        partName:   sizeLibrary.partName,
        svgContent: sizeLibrary.svgContent,
        capturedAt: sizeLibrary.capturedAt,
      })
      .from(sizeLibrary)
      .where(and(
        eq(sizeLibrary.productId, Number(req.params.id)),
        eq(sizeLibrary.partName, part)
      ))
      .orderBy(asc(sizeLibrary.sizeLabel));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.get('/:id/size-shapes', async (req, res) => {
  const size = req.query.size as string | undefined;
  if (!size) { res.status(400).json({ error: 'size query param required' }); return; }
  try {
    const rows = await db
      .select({
        id:         sizeLibrary.id,
        sizeLabel:  sizeLibrary.sizeLabel,
        partName:   sizeLibrary.partName,
        svgContent: sizeLibrary.svgContent,
        capturedAt: sizeLibrary.capturedAt,
      })
      .from(sizeLibrary)
      .where(and(
        eq(sizeLibrary.productId, Number(req.params.id)),
        eq(sizeLibrary.sizeLabel, size)
      ))
      .orderBy(asc(sizeLibrary.partName));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.get('/:id/captured-sizes', async (req, res) => {
  const part = req.query.part as string | undefined;
  if (!part) { res.status(400).json({ error: 'part query param required' }); return; }
  try {
    const rows = await db
      .select({ sizeLabel: sizeLibrary.sizeLabel })
      .from(sizeLibrary)
      .where(and(eq(sizeLibrary.productId, Number(req.params.id)), eq(sizeLibrary.partName, part)));
    res.json(rows.map(r => r.sizeLabel));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

export default router;
