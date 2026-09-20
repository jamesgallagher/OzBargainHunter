/**
 * A small, drift-correcting, overlap-safe repeating timer wheel.
 *
 * `createScheduler` takes a clock and injectable timer functions so the wheel
 * is testable without waiting on real time. It runs a task on a fixed
 * interval, correcting for drift so a slow tick does not shift every later
 * one: each beat is scheduled at its *absolute* time (anchor + N * interval),
 * not a fixed interval measured from the previous tick.
 *
 * It never overlaps a task with itself: if a poll is still running when the
 * next beat is due, that beat is skipped and recorded (not queued into a
 * backlog of overlapping runs). A task that throws is logged and the schedule
 * keeps running. `stop()` cancels the pending beat and resolves once an
 * in-flight tick has settled.
 *
 * The clock and timer functions are injected (not read from the globals), so
 * a test drives the whole wheel with `node:test` fake timers: pass the mocked
 * `setTimeout`/`clearTimeout` and a clock whose `now()` returns the mocked
 * `Date`.
 *
 * @param {object} deps
 * @param {{ now(): Date }} deps.clock the clock
 * @param {(fn: () => void, ms: number) => unknown} deps.setTimeout timer setter
 * @param {(id: unknown) => void} deps.clearTimeout timer clearer
 * @param {number} deps.intervalMs the fixed interval in milliseconds
 * @param {(beatIndex: number) => (Promise<unknown> | unknown)} deps.task the work
 * @param {(line: string) => void} [deps.log] log sink
 * @param {boolean} [deps.runImmediately] run the first beat at start (default false)
 * @returns {{ start(): void, stop(): Promise<void>, getSkippedBeats(): number, getTicks(): number, stats(): { ticks: number, skippedBeats: number } }}
 */
export function createScheduler({ clock, setTimeout, clearTimeout, intervalMs, task, log = () => {}, runImmediately = false }) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('createScheduler: intervalMs must be a positive number');
  }
  let stopped = false;
  let running = false;
  let timerId = null;
  let skippedBeats = 0;
  let tickCount = 0;
  const anchorMs = clock.now().getTime();
  let stopResolve = null;

  function scheduleNextBeat(nextIndex) {
    if (stopped) return;
    const nowMs = clock.now().getTime();
    const dueMs = anchorMs + nextIndex * intervalMs;
    const delay = Math.max(0, dueMs - nowMs);
    timerId = setTimeout(() => fireBeat(nextIndex), delay);
  }

  function fireBeat(nextIndex) {
    if (stopped) return;
    tickCount += 1;
    if (running) {
      // The previous task is still in flight: skip this beat and record it.
      // Do not queue an overlapping run.
      skippedBeats += 1;
      log(`beat ${nextIndex} skipped (task in flight)`);
    } else {
      running = true;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        running = false;
        if (stopResolve) {
          const r = stopResolve;
          stopResolve = null;
          r();
        }
      };
      let result;
      try {
        result = task(nextIndex);
      } catch (err) {
        log(`task threw: ${err && err.message ? err.message : err}`);
        settle();
        result = undefined;
      }
      if (result !== undefined && typeof result.then === 'function') {
        // Swallow the rejection *before* the finally, so the promise the
        // finally returns does not carry an unhandled rejection.
        result
          .catch((err) => log(`task threw: ${err && err.message ? err.message : err}`))
          .finally(settle);
      } else {
        settle();
      }
    }
    // Always reschedule to the next *absolute* beat (drift-corrected),
    // regardless of whether this beat ran or was skipped.
    scheduleNextBeat(nextIndex + 1);
  }

  function start() {
    if (stopped) return;
    if (runImmediately) {
      fireBeat(1);
    } else {
      scheduleNextBeat(1);
    }
  }

  function stop() {
    if (stopped) return Promise.resolve();
    stopped = true;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (running) {
      return new Promise((resolve) => {
        stopResolve = resolve;
      });
    }
    return Promise.resolve();
  }

  function getSkippedBeats() {
    return skippedBeats;
  }

  function getTicks() {
    return tickCount;
  }

  function stats() {
    return { ticks: tickCount, skippedBeats };
  }

  return { start, stop, getSkippedBeats, getTicks, stats };
}
