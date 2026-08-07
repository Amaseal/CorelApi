import 'dotenv/config';
import express from 'express';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './db';
import { requireApiKey } from './middleware/auth';
import productsRouter from './routes/products';
import libraryRouter  from './routes/library';
import settingsRouter from './routes/settings';
import ordersRouter   from './routes/orders';
import nestingRouter  from './routes/nesting';
import { initClipper } from './nesting/nfp';

const app = express();

app.use(express.json({ limit: '50mb' }));  // images sent as base64 can be large

// Logs every request (before auth, so even rejected/malformed requests show up) —
// makes "is anything even reaching the server" trivial to answer from Coolify's log view.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.use(requireApiKey);

app.use('/products', productsRouter);
app.use('/library',  libraryRouter);
app.use('/settings', settingsRouter);
app.use('/orders',   ordersRouter);
app.use('/nesting',  nestingRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

// Catches anything a route handler threw/rejected without its own try/catch, logs it with a
// stack trace, and returns a JSON 500 instead of letting Express's default (silent-ish) handler
// deal with it. Must be registered last and take all four args for Express to treat it as an
// error handler.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled route error:', err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception, exiting:', err);
  process.exit(1);
});

const PORT = Number(process.env.PORT ?? 3000);

async function start() {
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations applied.');

  await initClipper();
  console.log('Clipper2 WASM module loaded.');

  app.listen(PORT, () => {
    console.log(`Shape API listening on :${PORT}`);
  });
}

start().catch(err => {
  console.error('Startup failed:', err);
  pool.end();
  process.exit(1);
});
