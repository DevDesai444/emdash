// Crash recovery, measured instead of assumed. Two surfaces:
//
// 1. SQLite durability: a child process writes message rows and gets SIGKILLed
//    mid-write, K times. After each kill we reopen the db (WAL recovery runs on
//    open), check integrity, verify the row count never went backwards, and
//    prove it's still writable.
//
// 2. Worktree state: a child is killed mid worktree checkout loop. The durable
//    truth is git itself, so a cold WorktreeService must re-derive what exists
//    and removal must leave no stale dirs or registrations behind.
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { db } from '@main/db/client';
import { initializeDatabase } from '@main/db/initialize';
import { conversations, projects, tasks as tasksTable } from '@main/db/schema';
import { emitResult, fmtSummary, nowMs, summarize } from '../lib/metrics';
import { makeTempProject } from '../lib/repo';
import { makeBenchWorktreeService } from '../lib/worktree';
import { currentProfile } from '../profiles';

const PROJECT_ID = 'bench-project';
const appDir = process.cwd();
const workspaceRoot = path.resolve(appDir, '..', '..');
const viteNode = path.join(workspaceRoot, 'node_modules', 'vite-node', 'vite-node.mjs');
const viteConfig = path.join(appDir, 'tooling', 'bench', 'vite.config.ts');

function rand(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min));
}

// worktree dirs are identified by their .git pointer file; a torn checkout can
// leave one on disk without a matching git registration
function findWorktreeDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (fs.existsSync(path.join(p, '.git'))) out.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

interface ChildRun {
  waitReady: Promise<void>;
  waitExit: Promise<number | null>;
  kill: () => void;
  lastCount: () => number;
}

function spawnChild(script: string, extraEnv: Record<string, string>): ChildRun {
  // process.execPath is the electron binary and ELECTRON_RUN_AS_NODE is already
  // in our env, so children inherit the same runtime we're on
  const child = spawn(process.execPath, [viteNode, '--config', viteConfig, script], {
    cwd: appDir,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let count = 0;
  let readyResolve: () => void = () => {};
  const waitReady = new Promise<void>((res) => (readyResolve = res));
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line === 'READY') readyResolve();
      const m = line.match(/^(?:COUNT|CREATED) (\d+)/);
      if (m) count = parseInt(m[1], 10);
    }
  });
  const waitExit = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
  return {
    waitReady,
    waitExit,
    kill: () => child.kill('SIGKILL'),
    lastCount: () => count,
  };
}

// resolves 'ready' or 'exited' — a child that dies during startup must not hang the run
function readyOrExited(child: ChildRun): Promise<'ready' | 'exited'> {
  return Promise.race([
    child.waitReady.then(() => 'ready' as const),
    child.waitExit.then(() => 'exited' as const),
  ]);
}

async function dbCrashRounds(kills: number, delayMin: number, delayMax: number) {
  const dbFile = process.env.EMDASH_DB_FILE as string;

  await initializeDatabase();
  await db.insert(projects).values({ id: PROJECT_ID, name: 'bench', path: '/tmp/bench-repo' });
  await db
    .insert(tasksTable)
    .values({ id: 'crash-task', projectId: PROJECT_ID, name: 'crash task', status: 'running' });
  await db
    .insert(conversations)
    .values({ id: 'crash-conv', projectId: PROJECT_ID, taskId: 'crash-task', title: 'crash' });

  let integrityOk = 0;
  let writableOk = 0;
  let monotonicOk = 0;
  let setupFailures = 0;
  let lastCount = 0;
  const recoverySamples: number[] = [];

  for (let k = 0; k < kills; k++) {
    const child = spawnChild('tooling/bench/scenarios/crash-db-child.ts', {
      CRASH_CONV_ID: 'crash-conv',
    });
    if ((await readyOrExited(child)) === 'exited') {
      console.log(`round ${k}: child died before READY`);
      setupFailures++;
      continue;
    }
    await new Promise((res) => setTimeout(res, rand(delayMin, delayMax)));
    child.kill();
    await child.waitExit;

    const t0 = nowMs();
    try {
      // opening the file replays any WAL left behind by the killed writer
      const conn = new Database(dbFile);
      const integ = conn.pragma('integrity_check', { simple: true });
      if (String(integ).toLowerCase() === 'ok') integrityOk++;

      const row = conn.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
      if (row.c >= lastCount) monotonicOk++;
      lastCount = row.c;

      conn
        .prepare('INSERT INTO messages (id, conversation_id, content, sender) VALUES (?, ?, ?, ?)')
        .run(`probe-${k}`, 'crash-conv', 'probe', 'user');
      conn.prepare('DELETE FROM messages WHERE id = ?').run(`probe-${k}`);
      writableOk++;
      conn.close();
    } catch (error) {
      console.log(`round ${k}: verify error: ${(error as Error).message.slice(0, 120)}`);
    }
    recoverySamples.push(nowMs() - t0);
    console.log(
      `db kill ${k + 1}/${kills}: child wrote ~${child.lastCount()}, rows=${lastCount}, verify ${recoverySamples[recoverySamples.length - 1].toFixed(1)}ms`
    );
  }

  return {
    kills,
    setupFailures,
    integrityOk,
    writableOk,
    monotonicOk,
    finalRowCount: lastCount,
    recovery: summarize(recoverySamples),
  };
}

async function worktreeCrashRounds(
  kills: number,
  perKill: number,
  delayMin: number,
  delayMax: number
) {
  let totalFound = 0;
  let totalRemoveCallsOk = 0;
  let residualDirs = 0;
  let registrationLeftovers = 0;
  let setupFailures = 0;
  let cleanRounds = 0;
  const recoverySamples: number[] = [];

  for (let k = 0; k < kills; k++) {
    // fresh repo per round so a half-created worktree can't poison the next round
    const proj = makeTempProject(`crash-wt-${k}`);
    const child = spawnChild('tooling/bench/scenarios/crash-worktree-child.ts', {
      CRASH_REPO: proj.repoPath,
      CRASH_POOL: proj.worktreesDir,
      CRASH_COUNT: String(perKill),
    });
    if ((await readyOrExited(child)) === 'exited') {
      console.log(`round ${k}: child died before READY`);
      setupFailures++;
      proj.cleanup();
      continue;
    }
    await new Promise((res) => setTimeout(res, rand(delayMin, delayMax)));
    child.kill();
    await child.waitExit;

    const t0 = nowMs();
    // cold service: nothing in memory, re-derive from git alone. Discovery
    // source is git's own registry — the durable truth after a crash.
    const cold = makeBenchWorktreeService(proj.repoPath, proj.worktreesDir);
    const registered = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: proj.repoPath,
      stdio: 'pipe',
    })
      .toString()
      .split('\n\n')
      .map((block) => block.match(/^worktree (.+)$/m)?.[1])
      .filter((p): p is string => !!p && p.startsWith(proj.worktreesDir));
    const onDisk = findWorktreeDirs(proj.worktreesDir);
    const toRemove = [...new Set([...registered, ...onDisk])];
    const found = toRemove.length;
    const tornDirs = onDisk.filter((p) => !registered.includes(p)).length;
    let removeCallsOk = 0;
    for (const wtPath of toRemove) {
      try {
        await cold.svc.removeWorktree(wtPath);
        removeCallsOk++;
      } catch (error) {
        console.log(`remove failed: ${(error as Error).message.slice(0, 100)}`);
      }
    }
    execFileSync('git', ['worktree', 'prune'], { cwd: proj.repoPath, stdio: 'pipe' });
    const porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: proj.repoPath,
      stdio: 'pipe',
    })
      .toString()
      .split('\n\n')
      .filter((b) => b.trim()).length;
    const leftover = Math.max(0, porcelain - 1); // main checkout is always listed
    registrationLeftovers += leftover;
    const dirsAfter = findWorktreeDirs(proj.worktreesDir).length;
    residualDirs += dirsAfter;
    if (leftover === 0 && dirsAfter === 0) cleanRounds++;
    recoverySamples.push(nowMs() - t0);
    cold.dispose();

    totalFound += found;
    totalRemoveCallsOk += removeCallsOk;
    console.log(
      `wt kill ${k + 1}/${kills}: child created ~${child.lastCount()}, found ${found} (${tornDirs} torn), remove calls ok ${removeCallsOk}, residual ${dirsAfter}`
    );
    proj.cleanup();
  }

  return {
    kills,
    setupFailures,
    totalFound,
    totalRemoveCallsOk,
    cleanRounds,
    residualDirs,
    registrationLeftovers,
    recovery: summarize(recoverySamples),
  };
}

async function main(): Promise<void> {
  const { name: profile, cfg } = currentProfile();
  const c = cfg.crash;

  console.log(`db crash: ${c.dbKills} kill/verify rounds`);
  const dbResult = await dbCrashRounds(c.dbKills, c.killDelayMsMin, c.killDelayMsMax);
  console.log(
    `db recovery: integrity ${dbResult.integrityOk}/${dbResult.kills}, writable ${dbResult.writableOk}/${dbResult.kills}, monotonic ${dbResult.monotonicOk}/${dbResult.kills}`
  );
  console.log(fmtSummary('db verify', dbResult.recovery));

  console.log(`worktree crash: ${c.worktreeKills} rounds x ${c.worktreesPerKill} checkouts`);
  const wt = await worktreeCrashRounds(
    c.worktreeKills,
    c.worktreesPerKill,
    c.killDelayMsMin,
    c.killDelayMsMax
  );
  console.log(
    `wt recovery: ${wt.cleanRounds}/${wt.kills} rounds fully clean, remove calls ok ${wt.totalRemoveCallsOk}/${wt.totalFound}, residual dirs ${wt.residualDirs}, registration leftovers ${wt.registrationLeftovers}`
  );

  emitResult({ scenario: 'crash', profile, db: dbResult, worktrees: wt });
  const ok =
    dbResult.integrityOk === dbResult.kills - dbResult.setupFailures &&
    dbResult.writableOk === dbResult.integrityOk &&
    wt.cleanRounds === wt.kills - wt.setupFailures;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
