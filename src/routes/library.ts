import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { sizeLibrary } from '../db/schema';

const router = Router();

// GET /library/:id — fetch a single entry including full SVG content
router.get('/:id', async (req, res) => {
  try {
    const [row] = await db
      .select()
      .from(sizeLibrary)
      .where(eq(sizeLibrary.id, Number(req.params.id)));
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({
      id:         row.id,
      sizeLabel:  row.sizeLabel,
      partName:   row.partName,
      svgContent: row.svgContent,
      capturedAt: row.capturedAt,
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// DELETE /library/:id — remove a single captured shape
router.delete('/:id', async (req, res) => {
  try {
    await db.delete(sizeLibrary).where(eq(sizeLibrary.id, Number(req.params.id)));
    res.sendStatus(204);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

export default router;
