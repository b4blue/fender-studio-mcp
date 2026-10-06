// Timing on Studio Pro 8 (8.1.2), which differs from 5.5.2:
//  - Commands the bridge runs (Track/Add Audio Track, Track/Mute…) take effect just
//    after the bridge has answered, so the answer still shows the old state.
//  - Adding a plug-in and undoing it within ~100 ms crashed Studio Pro (a null
//    pointer in its plug-in host, dspshell), as did reading the inserts while an
//    undo was removing plug-ins. So plug-in adds and undo/redo wait before they answer.
export const PLUGIN_SETTLE_MS = Number(process.env.STUDIO_ONE_MCP_PLUGIN_SETTLE_MS ?? 1500);
export const UNDO_SETTLE_MS = Number(process.env.STUDIO_ONE_MCP_UNDO_SETTLE_MS ?? 500);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read until done(value) or the time is up; returns the last value read.
export async function until(read, done, { timeoutMs = 1500, everyMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let v = await read();
  while (!done(v) && Date.now() < deadline) {
    await sleep(everyMs);
    v = await read();
  }
  return v;
}

// Undo or redo, then give Studio One time to finish (removing a plug-in is not instant).
export async function undoRedo(call, op, args, { settleMs = UNDO_SETTLE_MS } = {}) {
  const r = await call(op, args);
  if (r && r.done) await sleep(settleMs);
  return r;
}
