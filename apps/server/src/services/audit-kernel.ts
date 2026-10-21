/**
 * Worker entry for the headless audit (spawned by `audit-worker.ts`, one per audit).
 *
 * Receives `{ code, tier, seed }`, runs the synchronous `auditModel` kernel, and posts the
 * outcome back. The outcome is plain data — the contracts' `AuditReport` and `ModelManifest`
 * are the serialisable artifact by design, so structured clone carries it; nothing here may
 * return a builder, a closure or a function.
 */
import { parentPort } from 'node:worker_threads';
import { auditModel, type AuditInput, type AuditOutcome } from './audit.ts';

if (!parentPort) throw new Error('audit-kernel must be spawned as a worker thread');

const FAIL = (message: string, timedOut: boolean): AuditOutcome => ({
  ok: false,
  message,
  timedOut,
});

parentPort.on('message', (input: AuditInput) => {
  if (!parentPort) return;
  try {
    if (
      !input ||
      typeof (input as { code?: unknown }).code !== 'string' ||
      typeof (input as { tier?: unknown }).tier !== 'string' ||
      typeof (input as { seed?: unknown }).seed !== 'number'
    ) {
      parentPort.postMessage(FAIL('The audit payload was malformed.', false));
      return;
    }
    // The kernel documents "never throws"; it is wrapped anyway: a budget error escaping the
    // sweep would otherwise kill the worker and read back as a silent exit rather than a
    // diagnosable audit failure.
    let outcome: AuditOutcome;
    try {
      outcome = auditModel(input);
    } catch (error) {
      outcome = FAIL(`The audit threw: ${(error as Error).message}`.slice(0, 400), false);
    }
    parentPort.postMessage(outcome);
  } catch (error) {
    parentPort.postMessage(
      FAIL(`The audit worker crashed: ${(error as Error).message}`.slice(0, 400), false),
    );
  }
});
