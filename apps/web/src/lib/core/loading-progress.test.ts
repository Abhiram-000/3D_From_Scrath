/**
 * The loading page's progress contract.
 *
 * The claim being tested is the one the platform makes to the learner: the progress bar and the
 * stage chips say what is *actually happening*, not what would be nice to be happening. Two
 * properties make that true, and both are easy to lose:
 *
 *   1. A milestone is only reached when the server announces the phase behind it. The bar may
 *      ease *within* a phase — "still working" — but it must never cross into the next phase's
 *     range on its own.
 *   2. The wording on screen is the server's. The client keeps a copy of the phase vocabulary for
 *     the stage mapping and the bar's milestones, but the sentence a learner reads comes from the
 *     server that is doing the work — otherwise the two drift, and a client copy is a claim about
 *     somebody else's behaviour.
 */
import { describe, expect, it } from 'vitest';
import type { GenerationEvent } from '@edu3d/contracts';
import { PHASES, ProgressModel, STAGES, type StageName } from './loading-progress';

const NOW = 1_000_000;

function phaseEvent(phase: string, message: string): GenerationEvent {
  return { type: 'phase', phase, message, at: 0 } as unknown as GenerationEvent;
}

function heartbeat(): GenerationEvent {
  return {
    type: 'heartbeat',
    phase: 'model',
    phaseSeconds: 3,
    at: 0,
  } as unknown as GenerationEvent;
}

function readyEvent(): GenerationEvent {
  return { type: 'ready', bundle: {} } as unknown as GenerationEvent;
}

describe('the stage the learner sees', () => {
  it('starts on the first stage', () => {
    const model = new ProgressModel(NOW);
    expect(model.stage).toBe('thinking');
  });

  it('moves only when the server announces a phase', () => {
    const model = new ProgressModel(NOW);
    // A heartbeat proves the run is alive; it says nothing about which phase is happening.
    model.apply(heartbeat(), NOW);
    expect(model.stage).toBe('thinking');
  });

  it('follows the phases the server announces', () => {
    const model = new ProgressModel(NOW);
    const seen: StageName[] = [];
    const announce = (phase: string, message: string) => {
      model.apply(phaseEvent(phase, message), NOW);
      seen.push(model.stage);
    };

    announce('queued', 'Sending your topic to the model…');
    announce('prompt', 'Loading the generation contract…');
    announce('model', 'The model is designing your 3D scene…');
    announce('extract', 'Reading the program the model wrote…');
    announce('repair', 'Repairing the program where it broke the rules…');
    announce('build', 'Building the model and checking what it teaches…');
    announce('refine', 'Improving the model where it fell short…');
    announce('ready', 'Your 3D model is ready!');

    // The four visible stages, in order, each one reached and never revisited.
    const distinct = seen.filter((stage, index) => stage !== seen[index - 1]);
    expect(distinct).toEqual(['thinking', 'generating', 'compiling']);
    expect(model.stage).toBe('compiling');

    model.apply(readyEvent(), NOW);
    expect(model.stage).toBe('ready');
  });

  it('never goes backwards when an earlier phase is announced again', () => {
    // The refinement pass re-runs the audit and the parse; those events must read as progress,
    // not as a rewind.
    const model = new ProgressModel(NOW);
    model.apply(phaseEvent('model', 'The model is designing your 3D scene…'), NOW);
    model.apply(phaseEvent('extract', 'Reading the program the model wrote…'), NOW);
    const stage = model.stage;
    const value = model.value;

    model.apply(phaseEvent('model', 'The model is designing your 3D scene…'), NOW);

    expect(model.stage).toBe(stage);
    expect(model.value).toBe(value);
  });

  it('advances to the nearest milestone for a phase it does not know', () => {
    // The wire vocabulary is deliberately finer-grained than the UI's, so a phase the client has
    // no slice for must still move the bar forward rather than be ignored. It lands on the last
    // milestone before it: the work that phase implies is done, and the work it announces has only
    // just started — claiming more than that would be a lie.
    const model = new ProgressModel(NOW);
    model.apply(phaseEvent('model', 'The model is designing your 3D scene…'), NOW);
    model.apply(phaseEvent('audit', 'Auditing what the model teaches…'), NOW);
    expect(model.value).toBeGreaterThan(6);
    expect(model.stage).toBe('generating');
  });
});

describe('the wording on screen', () => {
  it('is the sentence the server sent', () => {
    // A client-side copy of the wording is a claim about somebody else's behaviour, and it drifts:
    // the copy in this file already described an audit phase the server never announces. The
    // sentence on screen is therefore whatever the server said, and only that.
    const model = new ProgressModel(NOW);
    model.apply(phaseEvent('model', 'The server is doing something specific right now.'), NOW);
    expect(model.status).toBe('The server is doing something specific right now.');
  });

  it('has something to say before the first event arrives', () => {
    const model = new ProgressModel(NOW);
    expect(model.status.length).toBeGreaterThan(0);
  });
});

describe('the bar', () => {
  it('never crosses into a phase the server has not announced', () => {
    // Easing within a phase is "still working"; reaching the next milestone is "a step really
    // completed", and only the server can say that.
    const model = new ProgressModel(NOW);
    model.apply(phaseEvent('model', 'The model is designing your 3D scene…'), NOW);

    // Ten minutes of easing inside one phase must not reach the end of it.
    for (let minute = 0; minute < 10; minute += 1) {
      model.tick(NOW + minute * 60_000);
    }
    const phase = PHASES.find((entry) => entry.key === 'model');
    expect(model.value).toBeLessThan(phase?.to ?? 100);
  });

  it('moves when a phase is announced', () => {
    const model = new ProgressModel(NOW);
    const before = model.value;
    model.apply(phaseEvent('model', 'The model is designing your 3D scene…'), NOW);
    expect(model.value).toBeGreaterThan(before);
  });

  it('never moves backwards', () => {
    const model = new ProgressModel(NOW);
    model.apply(phaseEvent('model', 'The model is designing your 3D scene…'), NOW);
    const high = model.value;
    model.apply(phaseEvent('queued', 'Sending your topic to the model…'), NOW);
    model.tick(NOW + 1_000);
    expect(model.value).toBeGreaterThanOrEqual(high);
  });
});

describe('the chips', () => {
  it('mark every stage before the current one as completed', () => {
    const model = new ProgressModel(NOW);
    model.apply(phaseEvent('extract', 'Reading the program the model wrote…'), NOW);
    expect(model.stage).toBe('generating');
    expect(model.completedStages).toBe(STAGES.indexOf('generating'));
  });

  it('expose a view the page can copy into reactive state', () => {
    // The page renders plain values, not the model itself: a class instance is not reactive in
    // Svelte, and a getter read from one is a read that never invalidates.
    const model = new ProgressModel(NOW);
    model.apply(phaseEvent('extract', 'Reading the program the model wrote…'), NOW);
    const view = model.view();
    expect(view.stage).toBe('generating');
    expect(view.completedStages).toBe(STAGES.indexOf('generating'));
    expect(view.status).toBe('Reading the program the model wrote…');
    expect(typeof view.value).toBe('number');
  });
});
