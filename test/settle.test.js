// Studio Pro 8 timing (src/settle.js): edits that land just after the bridge
// answers are read until they show, and plug-in adds and undo wait before answering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTrack, trackState, addPlugin } from '../src/tracks.js';
import { until, undoRedo } from '../src/settle.js';

// A bridge whose edits apply one read late, like Studio Pro 8.
function lateBridge() {
  const tracks = [{ name: 'Vox', channel: 'Vox' }, { name: 'Bass', channel: 'Bass' }];
  const channels = [{ label: 'Vox', mute: 0 }, { label: 'Bass', mute: 0 }];
  const pending = [];
  const calls = [];
  const call = async (op, args) => {
    calls.push(op);
    const answer = (() => {
      switch (op) {
        case 'song': return { trackCount: tracks.length, selectedTracks: [] };
        case 'tracks': return tracks.filter((t) => !args.name || t.name.includes(args.name)).map((t) => ({ ...t }));
        case 'channels': return channels.map((c) => ({ ...c }));
        case 'addTrack':
          pending.push(() => tracks.push({ name: 'Track 3', channel: 'Track 3' }));
          return { added: [], trackCount: tracks.length };
        case 'trackState': {
          const c = channels.find((x) => x.label === args.track);
          pending.push(() => (c.mute = c.mute ? 0 : 1));
          return { track: args.track, action: args.action, channel: { ...c } };
        }
        default: throw new Error(`unexpected ${op}`);
      }
    })();
    if (op !== 'addTrack' && op !== 'trackState') while (pending.length) pending.shift()();
    return answer;
  };
  return { call, calls, tracks, channels };
}

test('addTrack reads until the new track is there', async () => {
  const b = lateBridge();
  assert.deepEqual(await addTrack(b.call, { type: 'audioMono' }), { added: ['Track 3'], trackCount: 3 });
});

test('trackState mute reports the channel after the toggle has landed', async () => {
  const b = lateBridge();
  const r = await trackState(b.call, { track: 'Bass', action: 'mute' });
  assert.equal(r.channel.mute, 1);
  assert.equal(b.channels[1].mute, 1);
});

test('until gives up after the timeout and returns the last value', async () => {
  let n = 0;
  const t0 = Date.now();
  assert.equal(await until(async () => ++n, () => false, { timeoutMs: 60, everyMs: 10 }), n);
  assert.ok(Date.now() - t0 >= 60 && n > 2);
});

test('addPlugin waits before it reads the inserts back', async () => {
  const at = {};
  const t0 = Date.now();
  const call = async (op, args) => {
    at[op] = Date.now() - t0;
    if (op === 'trackTask') return { results: [{ added: 'Pro EQ' }] };
    if (op === 'inserts') return [{ channel: 'Bass', inserts: [{ slot: 0, name: 'Pro EQ' }] }];
    throw new Error(`unexpected ${op}`);
  };
  const r = await addPlugin(call, { channel: 'Bass', plugin: 'Pro EQ' }, { settleMs: 80 });
  assert.equal(r.added, 'Pro EQ');
  assert.ok(at.inserts >= 80, `inserts read after ${at.inserts} ms`);
});

test('undo waits after an undo that ran, not after a refused one', async () => {
  let done = 1;
  const call = async () => ({ done });
  let t0 = Date.now();
  await undoRedo(call, 'undo', {}, { settleMs: 60 });
  assert.ok(Date.now() - t0 >= 60);
  done = 0;
  t0 = Date.now();
  await undoRedo(call, 'undo', {}, { settleMs: 60 });
  assert.ok(Date.now() - t0 < 40);
});
