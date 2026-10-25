import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export interface ConditionOptions {
  readonly message: string;
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  readonly diagnostics?: () => unknown;
}

/** Bound the complete wait, including an asynchronous predicate that never settles. */
export async function awaitCondition(predicate: () => boolean | Promise<boolean>, options: ConditionOptions): Promise<void> {
  const began = performance.now();
  const failure = new Error(options.message);
  let stopped = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        while (!stopped) {
          attempts++;
          if (await predicate()) return;
          await delay(options.intervalMs ?? 10);
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          let diagnostics = '';
          try { diagnostics = options.diagnostics ? `; state=${JSON.stringify(options.diagnostics())}` : ''; }
          catch { diagnostics = '; diagnostics unavailable'; }
          failure.message = `${options.message}; elapsed=${Math.round(performance.now() - began)}ms; attempts=${attempts}${diagnostics}; condition=${predicate.toString()}`;
          reject(failure);
        }, options.timeoutMs);
      }),
    ]);
  } finally { stopped = true; clearTimeout(timer); }
}
