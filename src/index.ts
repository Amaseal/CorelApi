import 'dotenv/config';
import express from 'express';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './db';
import { requireApiKey } from './middleware/auth';
import productsRouter from './routes/products';
import libraryRouter from './routes/library';

const app = express();

app.use(express.json({ limit: '20mb' }));  // SVG payloads can be large
app.use(requireApiKey);

app.use('/products', productsRouter);
app.use('/library',  libraryRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = Number(process.env.PORT ?? 3000);

async function start() {
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations applied.');

  app.listen(PORT, () => {
    console.log(`Shape API listening on :${PORT}`);
  });
}

start().catch(err => {
  console.error('Startup failed:', err);
  pool.end();
  process.exit(1);
});
