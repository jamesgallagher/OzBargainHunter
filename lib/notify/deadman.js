/**
 * The dead-man's-switch notifier (design 3.7).
 *
 * Sends what card 2's `deadManState` reports as due. `deadManState` decides
 * *when* a "no successful poll" notification is due on the decaying
 * schedule; this module composes and delivers it when it is due.
 *
 * The notification is a single high-priority alert naming the schedule step
 * and how long it has been since the last successful poll, delivered
 * through every selected provider via `fanout`.
 */

import { fanout } from './fanout.js';

/**
 * @param {object} args
 * @param {{ due: boolean, step: string, elapsedMs: number }} args.deadmanState
 *   the output of card 2's `deadManState`
 * @param {object[]} args.providers selected providers
 * @param {object} args.store the store
 * @param {object} args.clock { now(): Date }
 * @returns {Promise<{ sent: number, failed: number, disabled: string[], notices: object[] } | null>}
 *   the fan-out result, or null when no notification is due
 */
export async function sendDeadman({ deadmanState, providers, store, clock }) {
  if (!deadmanState || !deadmanState.due) return null;

  const hours = (deadmanState.elapsedMs / (60 * 60 * 1000)).toFixed(1);
  const notification = {
    title: `No successful poll for ${hours} hours`,
    body: `The dead-man's switch is sounding: no successful poll for ${hours} hours (step: ${deadmanState.step}). Check the acquisition status.`,
    url: '/status',
    priority: 'high',
    tags: ['deadman', deadmanState.step],
  };

  return fanout({ notifications: [notification], providers, store, clock });
}
