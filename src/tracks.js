// Track edits by name: rename and recolour (through the track's mixer channel),
// remove (Song/Remove Track on a selection of one). Seen on 5.5.2:
//  - rename and colour are not on the undo stack: the result carries "before";
//  - Remove Track is one undo step and asked nothing for an empty track;
//  - Track/Group Selected Tracks opens a name dialog, so grouping is not offered.

import { PLUGIN_SETTLE_MS, sleep, until } from './settle.js';

const hex = (rgb) => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
export const toArgb = (color) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color));
  if (!m) throw new Error('color must be "#rrggbb"');
  return (0xff000000 | parseInt(m[1], 16)) | 0;
};

// kind ("audio" or "instrument") tells apart tracks that share a name, like an
// audio stem and its MIDI render.
export const MEDIA_TYPE = { audio: 'Audio', instrument: 'Music' };

async function findTrack(call, name, kind) {
  const tracks = await call('tracks', { name, events: false });
  let hits = tracks.filter((t) => t.name === name);
  if (hits.length > 1 && kind) hits = hits.filter((t) => t.mediaType === MEDIA_TYPE[kind]);
  if (hits.length !== 1) throw new Error(hits.length ? `track name is ambiguous: ${name} (pass kind: audio or instrument)` : `no track named ${name}`);
  return hits[0];
}

async function restoreSelection(call, names) {
  for (const [i, name] of names.entries()) await call('selectTrack', { name, exclusive: i === 0 }).catch(() => {});
}

// A bus (the tracks' outputs are routed into it) or a VCA (controlling them) for
// some tracks, through Track/Add Bus|VCA for Selected Channels: no dialog, one
// undo step (checked on 5.5.2). The track selection is put back.
export async function addBus(call, { tracks, kind = 'bus' }) {
  const cmd = { bus: 'Add Bus for Selected Channels', vca: 'Add VCA for Selected Channels' }[kind];
  if (!cmd) throw new Error('kind must be bus or vca');
  if (!Array.isArray(tracks) || !tracks.length) throw new Error('tracks: one or more track names');
  const chans = [];
  for (const name of tracks) chans.push((await findTrack(call, name)).channel);
  const { selectedTracks } = await call('song');
  const before = new Set((await call('channels')).map((c) => c.label));
  let r;
  try {
    for (const [i, name] of tracks.entries()) await call('selectTrack', { name, exclusive: i === 0 });
    r = await call('command', { category: 'Track', name: cmd });
  } finally {
    await restoreSelection(call, selectedTracks);
  }
  if (!r.executed) throw new Error(`Track/${cmd} did not run`);
  const after = await call('channels');
  const added = after.filter((c) => !before.has(c.label)).map((c) => c.label);
  const routed = after.filter((c) => chans.includes(c.label)).map((c) => ({ channel: c.label, output: c.output }));
  return { kind, added, ...(kind === 'bus' ? { routed } : {}), note: 'One live_undo removes it (and puts the routing back).' };
}

// One operation through the MCP Track Edit task; its error, if any, becomes ours.
export async function trackTask(call, op) {
  const { results } = await call('trackTask', { ops: [op] });
  const r = results[0] || {};
  if (r.error) throw new Error(r.error);
  return r;
}

export async function trackEdit(call, { track, kind, action, name, color, to, folder, create, numbered, before, after }) {
  const t = await findTrack(call, track, kind);
  switch (action) {
    case 'move': {
      if ((before === undefined) === (after === undefined)) throw new Error('move needs exactly one of before or after (a track name)');
      const r = await trackTask(call, { op: 'moveTrack', track, before, after });
      return { track, ...(before ? { before } : { after }), order: r.order, note: 'One live_undo puts it back.' };
    }
    case 'route': {
      if (!to) throw new Error('route needs to (a bus or output channel name)');
      if (!t.channel) throw new Error(`${track} has no mixer channel to route`);
      const before = (await call('channels')).find((c) => c.label === t.channel)?.output ?? null;
      await trackTask(call, { op: 'route', channel: t.channel, to });
      const after = (await call('channels')).find((c) => c.label === t.channel)?.output ?? null;
      return { track, channel: t.channel, before, after, note: 'Route back to the "before" channel to undo.' };
    }
    case 'folder': {
      if (!folder) throw new Error('folder needs folder (a folder track name)');
      const r = await trackTask(call, { op: 'folder', folder, tracks: [track], create: !!create });
      if (r.missing?.length) throw new Error(`${track} could not be moved`);
      return { track, folder, created: !!r.created, note: 'live_undo reverts it (and the folder, if it was created: one more undo).' };
    }
    case 'renameEvents': {
      if (!name) throw new Error('renameEvents needs name');
      const before = (await call('tracks', { name: track })).find((x) => x.name === track)?.events.map((e) => e.name) ?? [];
      const r = await trackTask(call, { op: 'renameEvents', track, name, numbered: !!numbered });
      return { track, before, after: r.renamed, note: 'live_undo reverts it.' };
    }
    case 'rename': {
      if (!name) throw new Error('rename needs name');
      if (!t.channel) throw new Error(`${track} has no mixer channel to rename through`);
      await call('setChannelLabel', { channel: t.channel, name });
      return { renamed: { before: track, after: (await findTrack(call, name)).name }, note: 'Not on the undo stack: rename back to undo.' };
    }
    case 'color': {
      if (!t.channel) throw new Error(`${track} has no mixer channel to colour through`);
      const before = t.color;
      const r = await call('setChannelColor', { channel: t.channel, argb: toArgb(color) });
      return { track, before, after: hex(r.after), note: 'Not on the undo stack: set the "before" colour to undo.' };
    }
    case 'remove': {
      const { selectedTracks } = await call('song');
      const count0 = (await call('song')).trackCount;
      await call('selectTrack', { name: track, ...(kind ? { mediaType: MEDIA_TYPE[kind] } : {}) });
      // Song/Remove Track on Studio One 5; Session/Remove Track on Studio Pro 8.
      const cmd = (await call('command', { category: 'Song', name: 'Remove Track', checkOnly: true }).catch(() => null)) ? 'Song' : 'Session';
      const r = await call('command', { category: cmd, name: 'Remove Track' });
      await restoreSelection(call, selectedTracks.filter((n) => n !== track));
      if (!r.executed) throw new Error(`${cmd}/Remove Track did not run`);
      // Studio Pro 8 removes it just after the bridge answers (see settle.js).
      const { trackCount } = await until(() => call('song'), (s) => s.trackCount !== count0);
      return { removed: track, ...(kind ? { kind } : {}), trackCount, note: 'live_undo brings it back.' };
    }
    default:
      throw new Error(`unknown action ${action}`);
  }
}

// An instrument track with a new instance of an instrument (live_plugins with
// kind instrument lists them). One undo step removes both (checked on 5.5.2).
export async function addInstrumentTrack(call, { instrument, name }, { settleMs = PLUGIN_SETTLE_MS } = {}) {
  const r = await trackTask(call, { op: 'addInstrumentTrack', instrument, name });
  await sleep(settleMs); // see settle.js: a new plug-in must not be undone while it is being set up
  return { track: r.track, instrument: r.instrument, channel: r.channel, connected: r.connected, note: 'One live_undo removes the track and the instrument.' };
}

// A plug-in on a channel's inserts, through DeviceEditFunctions like Studio One's
// own Insert FX task: unlike the insert folder's own insertDeviceClass, this is
// on the undo stack.
export async function addPlugin(call, { channel, plugin }, { settleMs = PLUGIN_SETTLE_MS } = {}) {
  const r = await trackTask(call, { op: 'addPlugin', channel, plugin });
  await sleep(settleMs); // see settle.js: a new plug-in must not be undone while it is being set up
  const [rack] = await call('inserts', { channel });
  return { channel, added: r.added, inserts: rack ? rack.inserts : null, note: 'One live_undo removes it.' };
}

// An effect on a channel's sends: Studio One makes an FX channel with the plug-in
// and a send to it. Sending to an existing bus or FX channel is not reachable
// from scripts on 5.5.2, and this did not come off with one undo.
export async function addFxSend(call, { channel, plugin }, { settleMs = PLUGIN_SETTLE_MS } = {}) {
  const before = new Set((await call('channels')).map((c) => c.label));
  const r = await trackTask(call, { op: 'addFxSend', channel, plugin });
  await sleep(settleMs);
  const fx = (await call('channels')).filter((c) => !before.has(c.label)).map((c) => c.label);
  const [s] = await call('sends', { channel });
  return { channel, plugin: r.added, fxChannel: fx[0] ?? null, sends: s ? s.sends : [], note: 'Not reliably undone by live_undo: remove the send and FX channel in Studio One, or mute the send with live_set_send.' };
}

// Add a track. On Studio Pro 8 the track appears just after the bridge answers,
// so read until it is there rather than trusting the answer's count.
export async function addTrack(call, args = {}) {
  const count0 = (await call('song')).trackCount;
  const names0 = (await call('tracks', { events: false })).map((t) => t.name);
  const r = await call('addTrack', args);
  if (r.trackCount !== count0 && r.added.length) return r;
  const tracks = await until(() => call('tracks', { events: false }), (ts) => ts.length !== names0.length);
  const left = [...names0];
  const added = tracks.map((t) => t.name).filter((n) => { const i = left.indexOf(n); if (i < 0) return true; left.splice(i, 1); return false; });
  return { added, trackCount: (await call('song')).trackCount };
}

// Toggle arm/monitor/mute/solo on a track. On Studio Pro 8 the toggle lands just
// after the bridge answers, so read the channel until it differs from before.
const TOGGLES = { arm: 'recordArmed', monitor: 'monitor', mute: 'mute', solo: 'solo' };
export async function trackState(call, args) {
  const field = TOGGLES[args.action];
  if (!field) return call('trackState', args);
  const label = (await findTrack(call, args.track)).channel;
  const read = async () => (await call('channels')).find((c) => c.label === label) || null;
  const before = await read();
  const r = await call('trackState', args);
  if (!before || (r.channel && r.channel[field] !== before[field])) return r;
  const channel = await until(read, (c) => !c || c[field] !== before[field]);
  return { ...r, channel };
}
