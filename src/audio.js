// Hearing the mix (macOS 14.2+): audio/bin/s1tap records what Studio One plays
// through a Core Audio process tap (nothing installed, the output device left
// alone), and audio/analyze.py measures a recording. Build both with
// `npm run build:audio`.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './paths.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'audio');
export const tapBin = join(root, 'bin', 's1tap');
export const python = join(root, '.venv', 'bin', 'python');
export const analyzer = join(root, 'analyze.py');
export const capturesDir = join(dataDir, 'captures');

// Both helpers print one JSON object; an error comes back as {"error"} with a non-zero exit.
export function runJson(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const parse = (s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      };
      const out = parse(stdout) || parse(stderr.trim().split('\n').pop() || '');
      if (out && out.error) return reject(new Error(out.error));
      if (err) return reject(new Error(`${cmd.split('/').pop()} failed: ${(stderr || err.message).trim()}`));
      if (!out) return reject(new Error(`${cmd.split('/').pop()} printed no result`));
      resolve(out);
    });
  });
}

export function studioPid() {
  try {
    const pids = execFileSync('pgrep', ['-f', '/Contents/MacOS/(studioapp|Studio Pro)( |$)'], { encoding: 'utf8' }).trim().split('\n');
    return Number(pids[0]) || null;
  } catch {
    return null;
  }
}

const stamp = (d) => d.toISOString().replace(/[:.]/g, '-').replace('Z', '');

// Record `seconds` of Studio One's output. If the transport is stopped, it plays
// from the given position (or where the playhead is) and afterwards stops and puts
// the playhead back. The metronome click and precount are off while it plays and
// set back after, so they are not in the recording. Never records in Studio One.
export async function capture(call, { seconds, from_seconds, from_bars, out } = {}, deps = {}) {
  const { run = runJson, pid = studioPid, now = () => new Date(), bin = tapBin } = deps;
  if (!(seconds > 0 && seconds <= 600)) throw new Error('seconds must be more than 0 and at most 600');
  if (!existsSync(bin)) throw new Error('s1tap is not built: run "npm run build:audio" in studio-one-mcp');
  const p = pid();
  if (!p) throw new Error('Studio One is not running');
  const t = (await call('song')).transport;
  if (t.recording) throw new Error('Studio One is recording; capture leaves the transport alone');
  const file = out || join(capturesDir, `${stamp(now())}.wav`);
  mkdirSync(dirname(file), { recursive: true });
  const startsPlay = !t.playing;
  const home = t.position.seconds;
  let metro = null;
  let result;
  try {
    if (from_seconds !== undefined || from_bars !== undefined) await call('setTransport', { positionSeconds: from_seconds, positionBars: from_bars });
    if (startsPlay) {
      metro = await call('metronome', {});
      if (metro.click || metro.precount) await call('metronome', { click: false, precount: false });
      await call('transport', { action: 'play' });
    }
    result = await run(bin, ['--pid', String(p), '--seconds', String(seconds), '--out', file], (seconds + 15) * 1000);
  } finally {
    if (startsPlay) {
      await call('transport', { action: 'stop' }).catch(() => {});
      await call('setTransport', { positionSeconds: home }).catch(() => {});
      if (metro && (metro.click || metro.precount)) await call('metronome', { click: metro.click, precount: metro.precount }).catch(() => {});
    }
  }
  return {
    ...result,
    from: from_bars ?? from_seconds ?? home,
    transport: startsPlay ? 'played for the capture, then stopped; playhead put back' : 'was already playing; left playing',
  };
}

// Measure a recording, optionally against a reference; writes a PNG next to it.
export async function analyze({ file, reference, sections, segment, plot = true } = {}, deps = {}) {
  const { run = runJson, py = python } = deps;
  if (!existsSync(py)) throw new Error('the analyzer is not set up: run "npm run build:audio" in studio-one-mcp');
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  if (reference && !existsSync(reference)) throw new Error(`no such file: ${reference}`);
  const args = [analyzer, file];
  if (reference) args.push('--reference', reference);
  if (sections) args.push('--sections', JSON.stringify(sections));
  if (segment) args.push('--segment', String(segment));
  if (plot) args.push('--plot', file.replace(/\.wav$/i, '') + (reference ? '-vs-reference' : '') + '.png');
  return run(py, args, 300000);
}
