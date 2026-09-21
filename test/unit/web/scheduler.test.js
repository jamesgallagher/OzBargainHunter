import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../../../lib/scheduler.js';

/**
 * Flush the microtask queue (and any macrotasks the mocks queued) so a
 * promise's settlement — e.g. a task's inner timer resolving and resetting
 * the scheduler's `running` flag — is applied before the next beat is
 * evaluated. node:test's `tick()` runs timer callbacks synchronously but does
 * not drain the microtask queue, so an async task's settlement would
 * otherwise lag a beat behind and the scheduler would skip a beat it should
 * run.
 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Run a scheduler under node:test fake timers. Enabling
 * `apis: ['setTimeout', 'Date']` replaces the global setTimeout and Date with
 * mocks; the scheduler is handed those globals (now the mocks) and we advance
 * time with `t.mock.timers.tick(ms)` followed by a microtask flush.
 */
function runWithFakeTimers(t, { intervalMs, task, runImmediately = false, log = () => {} }) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const clock = { now: () => new Date() };
  const scheduler = createScheduler({
    clock,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    intervalMs,
    task,
    log,
    runImmediately,
  });
  scheduler.start();
  return {
    scheduler,
    // Advance the clock by ms and flush the microtask queue.
    advance: async (ms) => {
      t.mock.timers.tick(ms);
      await flush();
    },
  };
}

describe('scheduler: once per interval', () => {
  test('runs a task once per interval', async (t) => {
    const calls = [];
    const { advance } = runWithFakeTimers(t, { intervalMs: 1000, task: (i) => calls.push(i) });
    await advance(1000);
    assert.deepEqual(calls, [1]);
    await advance(1000);
    await advance(1000);
    assert.deepEqual(calls, [1, 2, 3]);
  });
});

describe('scheduler: no overlap', () => {
  test('a task taking longer than one interval causes exactly one skipped beat, recorded, not a queue of overlapping runs', async (t) => {
    const calls = [];
    const { scheduler, advance } = runWithFakeTimers(t, {
      intervalMs: 1000,
      // The task takes 1500 ms (longer than the 1000 ms interval).
      task: async (i) => {
        calls.push(i);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      },
    });
    await advance(1000); // beat 1 starts (in flight, inner timer at 2500)
    await advance(1000); // beat 2 due at 2000 while beat 1 still running -> skipped
    await advance(500); // 2500: beat 1's inner timer fires; beat 1 settles (beat 3 due at 3000, not yet)
    assert.equal(scheduler.getTicks(), 2, 'two beats fired (one ran, one skipped)');
    assert.equal(scheduler.getSkippedBeats(), 1, 'exactly one skipped beat recorded');
    assert.deepEqual(calls, [1], 'no overlapping run was queued');
  });
});

describe('scheduler: a throwing task does not stop the schedule', () => {
  test('a throwing task is logged and the schedule keeps running', async (t) => {
    const calls = [];
    const errors = [];
    const { advance } = runWithFakeTimers(t, {
      intervalMs: 1000,
      task: (i) => {
        calls.push(i);
        if (i === 1) throw new Error('boom');
      },
      log: (line) => {
        if (line.includes('boom')) errors.push(line);
      },
    });
    await advance(1000); // beat 1 throws
    await advance(1000); // beat 2 still runs
    assert.deepEqual(calls, [1, 2], 'the schedule kept running after the throw');
    assert.ok(errors.length >= 1, 'the throw was logged');
  });

  test('an async task that rejects does not stop the schedule', async (t) => {
    const calls = [];
    const { advance } = runWithFakeTimers(t, {
      intervalMs: 1000,
      task: async (i) => {
        calls.push(i);
        if (i === 1) throw new Error('async boom');
      },
    });
    await advance(1000); // beat 1 rejects (caught by the scheduler)
    await advance(1000); // beat 2 still runs
    assert.deepEqual(calls, [1, 2]);
  });
});

describe('scheduler: drift does not accumulate', () => {
  test('a slow tick does not shift every later one (drift does not accumulate over 20 ticks)', async (t) => {
    const calls = [];
    const { advance } = runWithFakeTimers(t, {
      intervalMs: 1000,
      // The task takes 500 ms (half the interval) — a slow tick.
      task: async (i) => {
        calls.push(i);
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
    });
    // Advance in 500 ms steps (half the interval) so the task's inner 500 ms
    // timer and the next beat land in separate tick() windows, with a
    // microtask flush between them. A single 1000 ms step would put both in
    // one window, and the settle microtask from the inner timer would not
    // drain before the next beat's callback — falsely skipping the beat.
    // 40 steps of 500 ms = 20 intervals.
    for (let i = 0; i < 40; i += 1) {
      await advance(500);
    }
    assert.equal(calls.length, 20, 'exactly 20 beats ran over 20 intervals (no drift)');
  });
});

describe('scheduler: stop cleanly', () => {
  test('stop() cancels the pending beat and resolves once an in-flight tick has settled', async (t) => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { scheduler, advance } = runWithFakeTimers(t, {
      intervalMs: 1000,
      task: async (i) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        inFlight -= 1;
      },
    });
    await advance(1000); // beat 1 starts (in flight)
    const stopPromise = scheduler.stop();
    await advance(2000); // let the in-flight tick finish
    await stopPromise;
    assert.equal(inFlight, 0, 'the in-flight tick settled before stop resolved');
    assert.equal(maxInFlight, 1, 'the task never overlapped with itself');
  });
});
