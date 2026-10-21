/**
 * The worker host for the headless audit: runs `auditModel` off the request thread.
 *
 * `04-BACKEND.md:67` and `PLAN.md:156` claim the audit's CPU work runs on worker threads; it
 * actually ran inline on the event loop — `node:vm`'s timeout blocks the host thread, so one
 * generation's audit froze every other request (other learners' NDJSON heartbeats, static
 * responses, the SIGTERM handler) for ~0.2 s typically and up to ~20 s at the build deadline.
 *
 * Properties worth stating because the pipeline depends on them:
 *
 *   - **Fresh worker per audit, always terminated.** A poisoned realm or a wedged build can
 *     never leak into the next request; termination is the hard stop a guest that dodged the
 *     loop guard cannot outlive (the `node:vm` build deadline still applies inside too).
 *   - **The pool cannot be wedged.** `deadlineMs` bounds the whole request→result window; the
 *     host races it against the worker's answer and terminates on cap — returning a
 *     `timedOut` audit failure, never hanging the caller.
 *   - **Plain data crosses by structured clone.** `AuditInput` is strings/numbers in; the
 *     outcome is the contracts' serialisable manifest + report out. No builder, no closure
 *     and no function ever crosses — the drain of the boundary is the point of the manifest.
 *   - **Spawn cost is real and visible.** A fresh worker loads the engine module graph, which
 *     measured ~410–450 ms on this machine; the kernel itself stays ~0.2 s on the reference
 *     turbofan. The cost is per-audit, once, and the request thread never blocks.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { AuditInput, AuditOutcome } from './audit.ts';
import { SANDBOX_LIMITS } from '@edu3d/contracts';

/**
 * Hard cap for the whole audit (build + parameter sweep) unless the caller narrows it. The
 * guest's own `vm` deadline bounds the build at `SANDBOX_LIMITS.buildDeadlineMs`; the sweep
 * re-runs guest frames under the same guard, so one more full build-budget of headroom plus
 * spawn margin keeps a legitimate slow audit safe while a wedged one cannot hold a slot.
 */
export const AUDIT_WORKER_DEADLINE_MS = SANDBOX_LIMITS.buildDeadlineMs * 2 + 5_000;

/** Resolve the worker entry next to this file; type stripping is native on Node ≥23.6. */
const WORKER_FILE = fileURLToPath(new URL('./audit-kernel.ts', import.meta.url));

async function messageWorker(input: AuditInput, deadlineMs: number): Promise<AuditOutcome> {
  const worker = new Worker(WORKER_FILE, {
    resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 32 },
  });
  worker.unref(); // an in-flight audit must never hold shutdown hostage; terminate() below joins it

  return new Promise<AuditOutcome>((resolve) => {
    let settled = false;
    const outcome: AuditOutcome = {
      ok: false,
      message: 'The audit was interrupted before it could finish.',
      timedOut: false,
    };
    const settle = (value: AuditOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      resolve(value);
    };
    const cap = setTimeout(() => {
      settle({
        ok: false,
        message:
          'The audit exceeded its CPU time budget and was stopped. Reduce procedural detail so the model can be measured.',
        timedOut: true,
      });
    }, deadlineMs);

    worker.on('online', () => {
      if (settled) return;
      try {
        worker.postMessage({ code: input.code, tier: input.tier, seed: input.seed });
      } catch (error) {
        settle({
          ok: false,
          message:
            `The audit worker could not receive its input: ${(error as Error).message}`.slice(
              0,
              400,
            ),
          timedOut: false,
        });
      }
    });
    worker.on('message', (message: unknown) => {
      settle((message as AuditOutcome) ?? outcome);
    });
    worker.on('error', (error: Error) => {
      settle({
        ok: false,
        message: `The audit worker failed: ${error.message}`.slice(0, 400),
        timedOut: false,
      });
    });
    worker.on('exit', () => {
      settle(outcome); // a silent exit without a message is a failure, not a hang
    });
  }).finally(() => void worker.terminate());
}

/** The audit, off-thread. Same observable outcome as the synchronous kernel `auditModel`. */
export async function auditModelAsync(
  input: AuditInput & { deadlineMs?: number },
): Promise<AuditOutcome> {
  const { deadlineMs, ...rest } = input;
  return messageWorker(rest as AuditInput, deadlineMs ?? AUDIT_WORKER_DEADLINE_MS);
}
