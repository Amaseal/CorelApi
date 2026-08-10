// Worker-thread entry point for nesting's population evaluation. Each worker is a long-lived
// thread (see workerPool.ts) that loads its own Clipper2 WASM module once, then evaluates one
// packAttempt per message for the lifetime of the process — packAttempt is the only CPU-heavy
// part of nesting (see nest.ts/packer.ts comments), so running several of these in parallel is
// what actually lets the GA use more than one core.
import { parentPort } from 'worker_threads';
import { initClipper } from './nfp';
import { packAttempt } from './packer';
import { NestingError, PartInstance, SheetSize } from './types';

if (!parentPort) throw new Error('worker.ts must be run as a worker_threads Worker');
const port = parentPort;

interface PackRequest {
  id: number;
  sheet: SheetSize;
  gap: number;
  instances: PartInstance[];
}

// Queued rather than dropped: the pool won't post a message until this resolves in practice, but
// guarding here too means a burst of messages right at worker startup can't race init.
const ready = initClipper();

port.on('message', async (msg: PackRequest) => {
  try {
    await ready;
    const result = await packAttempt(msg.sheet, msg.gap, msg.instances);
    port.postMessage({ id: msg.id, result });
  } catch (e) {
    port.postMessage({
      id: msg.id,
      error: {
        message: e instanceof Error ? e.message : String(e),
        isNestingError: e instanceof NestingError,
      },
    });
  }
});
