#!/usr/bin/env node
// Bench launcher.
//
//   node tooling/bench/run.cjs                     # every scenario, standard profile
//   node tooling/bench/run.cjs worktrees           # one scenario
//   node tooling/bench/run.cjs all --profile heavy --json results.json
//
// Scenarios run under the repo's Electron binary with ELECTRON_RUN_AS_NODE=1 so
// the electron-rebuilt native modules (node-pty, better-sqlite3) load exactly as
// they do in the app. vite-node handles TS + aliases via tooling/bench/vite.config.ts.
// Env that must exist before any src/main import (EMDASH_DB_FILE, BENCH_SCRATCH)
// is set here, not in the scenarios, because src/main/db/client.ts opens the
// database at module load.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appDir = path.resolve(__dirname, '..', '..');
const workspaceRoot = path.resolve(appDir, '..', '..');
// electron's index.js exports the binary path when required outside electron
const electronBin = require('electron');
const viteNode = path.join(workspaceRoot, 'node_modules', 'vite-node', 'vite-node.mjs');

const SCENARIOS = {
  worktrees: 'tooling/bench/scenarios/worktrees.ts',
  tasks: 'tooling/bench/scenarios/tasks.ts',
  db: 'tooling/bench/scenarios/db.ts',
  pty: 'tooling/bench/scenarios/pty.ts',
  crash: 'tooling/bench/scenarios/crash.ts',
};
const DEFAULT_ORDER = ['worktrees', 'tasks', 'db', 'pty', 'crash'];

function parseArgs(argv) {
  const args = { scenario: 'all', profile: 'standard', json: null };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('--')) args.scenario = rest.shift();
  while (rest.length) {
    const a = rest.shift();
    if (a === '--profile') args.profile = rest.shift();
    else if (a === '--json') args.json = rest.shift();
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function runScenario(name, profile) {
  return new Promise((resolve) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `emdash-bench-${name}-`));
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      BENCH_SCRATCH: scratch,
      BENCH_PROFILE: profile,
      EMDASH_DB_FILE: path.join(scratch, 'emdash.db'),
    };
    const started = Date.now();
    const child = spawn(
      electronBin,
      [viteNode, '--config', 'tooling/bench/vite.config.ts', SCENARIOS[name]],
      { cwd: appDir, env, stdio: ['ignore', 'pipe', 'inherit'] }
    );
    let result = null;
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith('@@RESULT ')) {
          try {
            result = JSON.parse(line.slice('@@RESULT '.length));
          } catch {
            console.error(`[${name}] bad result line`);
          }
        } else {
          console.log(`[${name}] ${line}`);
        }
      }
    });
    child.on('exit', (code) => {
      // scratch can hold a whole temp repo + worktrees; keep only when debugging
      if (!process.env.BENCH_KEEP_SCRATCH) {
        try {
          fs.rmSync(scratch, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      resolve({ name, code, wallMs: Date.now() - started, result });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const names =
    args.scenario === 'all' ? DEFAULT_ORDER : SCENARIOS[args.scenario] ? [args.scenario] : null;
  if (!names) {
    console.error(
      `unknown scenario '${args.scenario}' (have: ${Object.keys(SCENARIOS).join(', ')}, all)`
    );
    process.exit(1);
  }

  console.log(`profile: ${args.profile}`);
  const runs = [];
  for (const name of names) {
    console.log(`\n=== ${name} ===`);
    runs.push(await runScenario(name, args.profile));
  }

  const failed = runs.filter((r) => r.code !== 0 || !r.result);
  console.log('\n=== summary ===');
  for (const r of runs) {
    console.log(
      `${r.name.padEnd(10)} ${r.code === 0 && r.result ? 'ok ' : 'FAIL'} ${(r.wallMs / 1000).toFixed(1)}s`
    );
  }

  if (args.json) {
    const out = {
      profile: args.profile,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpus: os.cpus().length,
      node: process.versions.node,
      ranAt: new Date().toISOString(),
      scenarios: Object.fromEntries(runs.map((r) => [r.name, r.result])),
    };
    fs.writeFileSync(args.json, JSON.stringify(out, null, 2));
    console.log(`wrote ${args.json}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main();
