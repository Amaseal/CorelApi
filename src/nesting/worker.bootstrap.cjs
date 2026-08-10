// Dev-only entry point for the worker pool (see workerPool.ts's workerEntryPath) — used only when
// running under tsx, never in the compiled prod build (which spawns worker.js directly, already
// plain JS, no transpilation needed).
//
// Why this exists: a worker_threads Worker resolves and loads its OWN entry module independently
// of whatever loader hooks the parent thread registered (tsx's ESM loader flag, `--import tsx`,
// does not carry over to a freshly spawned worker's module resolution — confirmed empirically,
// passing it via execArgv still throws ERR_UNKNOWN_FILE_EXTENSION for a .ts entry). Requiring
// 'tsx/cjs' here registers a CommonJS require() hook IN THIS WORKER THREAD that transpiles .ts
// (esbuild, same as tsx's normal require-time transform) before worker.ts's own require() call
// below loads it.
require('tsx/cjs');
require('./worker.ts');
