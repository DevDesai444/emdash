// PTY streaming: N concurrent sessions through spawnLocalPty (the app's local
// pty path), each running a mock agent that emits a known number of numbered
// lines. Checks throughput AND completeness — delivered/expected per session —
// since silent output loss is the failure mode that actually hurts in a
// terminal-streaming app. Delivery is verified at the configured emission rate;
// this is not a max-throughput test.
import * as path from 'node:path';
import { spawnLocalPty } from '@main/core/pty/local-pty';
import { currentProfile } from '../profiles';
import { emitResult, fmtSummary, nowMs, summarize } from '../lib/metrics';

interface SessionStat {
  tag: string;
  bytes: number;
  linesSeen: number;
  done: boolean;
  exited: boolean;
  firstLineMs: number | null;
  exitCode: number | null | undefined;
}

async function main(): Promise<void> {
  const { name: profile, cfg } = currentProfile();
  const { sessions, lineRate, lines, lineBytes } = cfg.pty;
  const mock = path.resolve('tooling/bench/mock-agent.cjs');

  const expectedPerSession = lines;
  const stats: SessionStat[] = [];
  const spawnStart = nowMs();
  console.log(
    `spawning ${sessions} pty sessions, ${lineRate} lines/s x ${lines} lines x ${lineBytes}B each`
  );

  const doneP: Promise<void>[] = [];
  for (let s = 0; s < sessions; s++) {
    const tag = `S${s}`;
    const stat: SessionStat = {
      tag,
      bytes: 0,
      linesSeen: 0,
      done: false,
      exited: false,
      firstLineMs: null,
      exitCode: null,
    };
    stats.push(stat);
    const t0 = nowMs();
    // process.execPath is the electron binary; the child needs the run-as-node
    // switch too or it would boot the GUI app
    const pty = spawnLocalPty({
      id: `bench-${tag}`,
      command: process.execPath,
      args: [mock, '--lines', String(lines), '--rate', String(lineRate), '--bytes', String(lineBytes), '--tag', tag],
      cwd: process.cwd(),
      env: { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: '1' },
      cols: 120,
      rows: 32,
    });
    const marker = `${tag}:`;
    // line-buffer the stream: a marker can straddle two onData chunks, so only
    // count on complete lines and carry the partial tail over
    let tail = '';
    const scanLine = (line: string): void => {
      if (!line.includes(marker)) return;
      if (line.includes(`${marker}DONE`)) {
        stat.done = true;
        return;
      }
      stat.linesSeen++;
      if (stat.firstLineMs === null) stat.firstLineMs = nowMs() - t0;
    };
    doneP.push(
      new Promise<void>((resolve) => {
        pty.onData((data: string) => {
          stat.bytes += data.length;
          const parts = (tail + data).split('\n');
          tail = parts.pop() ?? '';
          for (const line of parts) scanLine(line);
        });
        pty.onExit((info) => {
          if (tail) scanLine(tail);
          stat.exited = true;
          stat.exitCode = info.exitCode;
          resolve();
        });
      })
    );
  }

  // generous guard: emission time + spawn slack
  const timeoutMs = (lines / lineRate) * 1000 * 3 + 20000;
  const timedOut = await Promise.race([
    Promise.all(doneP).then(() => false),
    new Promise<boolean>((res) => setTimeout(() => res(true), timeoutMs)),
  ]);
  const wallMs = nowMs() - spawnStart;

  const totalBytes = stats.reduce((a, s) => a + s.bytes, 0);
  const firstLine = summarize(
    stats.filter((s) => s.firstLineMs !== null).map((s) => s.firstLineMs as number)
  );
  const ratios = stats.map((s) => Math.min(s.linesSeen, expectedPerSession) / expectedPerSession);
  const minRatio = Math.min(...ratios);
  const meanRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const doneCount = stats.filter((s) => s.done).length;

  console.log(fmtSummary('first agent line', firstLine));
  console.log(
    `throughput: ${(totalBytes / 1024 / (wallMs / 1000)).toFixed(1)} KiB/s aggregate over ${sessions} sessions`
  );
  console.log(
    `completeness: ${doneCount}/${sessions} DONE markers, delivered ratio mean=${(meanRatio * 100).toFixed(2)}% min=${(minRatio * 100).toFixed(2)}%${timedOut ? ' (TIMED OUT)' : ''}`
  );

  emitResult({
    scenario: 'pty',
    profile,
    config: { sessions, lineRate, lines, lineBytes },
    wallMs: Math.round(wallMs),
    timedOut,
    aggregateKiBPerSec: Math.round((totalBytes / 1024 / (wallMs / 1000)) * 10) / 10,
    totalBytes,
    firstAgentLine: firstLine,
    doneMarkers: doneCount,
    deliveredRatioMean: Math.round(meanRatio * 10000) / 10000,
    deliveredRatioMin: Math.round(minRatio * 10000) / 10000,
    nonZeroExits: stats.filter((s) => s.exitCode != null && s.exitCode !== 0).length,
    note: 'delivery completeness at the configured emission rate, measured at the main-process pty consumer',
  });
  // a timed-out or incomplete run is a failure, not a soft pass
  process.exit(!timedOut && doneCount === sessions ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
