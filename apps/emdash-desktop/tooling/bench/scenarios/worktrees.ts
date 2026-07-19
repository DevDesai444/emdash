// Worktree lifecycle under load: check out N branch worktrees with C requested
// concurrently, re-derive state with a cold service (what a restart sees), then
// remove everything. Note the service serializes git ops through an internal
// queue, so per-op latency includes queue wait — the wall-clock throughput is
// the number that matters at concurrency.
import { execFileSync } from 'node:child_process';
import { currentProfile } from '../profiles';
import { emitResult, fmtSummary, nowMs, runPool, summarize, timed } from '../lib/metrics';
import { makeTempProject } from '../lib/repo';
import { makeBenchWorktreeService } from '../lib/worktree';

async function main(): Promise<void> {
  const { name: profile, cfg } = currentProfile();
  const { tasks, concurrency } = cfg.worktrees;
  const proj = makeTempProject('worktrees');
  const { svc, ctx, dispose } = makeBenchWorktreeService(proj.repoPath, proj.worktreesDir);
  const runId = Math.random().toString(36).slice(2, 7);

  console.log(`checking out ${tasks} branch worktrees, ${concurrency} requested concurrently`);
  const createSamples: number[] = [];
  const created: Array<{ branch: string; path: string }> = [];
  let setupFailed = 0;
  let branchNotFound = 0;

  const wallStart = nowMs();
  await runPool(
    Array.from({ length: tasks }, (_, i) => i),
    concurrency,
    async (i) => {
      const branch = `bench/task-${runId}-${i}`;
      const res = await timed(createSamples, () =>
        svc.checkoutBranchWorktree({ type: 'local', branch: 'main' }, branch, {
          copyPreservedFiles: true,
        })
      );
      if (res.success) {
        created.push({ branch, path: res.data });
      } else {
        if (res.error.type === 'branch-not-found') branchNotFound++;
        else setupFailed++;
        console.log(`checkout ${branch} failed: ${JSON.stringify(res.error).slice(0, 140)}`);
      }
    }
  );
  const createWallMs = nowMs() - wallStart;

  // a cold service (fresh instance, nothing in memory) must re-derive every
  // worktree from git alone — the restart/recovery read path
  const cold = makeBenchWorktreeService(proj.repoPath, proj.worktreesDir);
  const coldStart = nowMs();
  let coldFound = 0;
  for (const wt of created) {
    if (await cold.svc.getWorktree(wt.branch)) coldFound++;
  }
  const coldLookupMs = nowMs() - coldStart;
  cold.dispose();

  const porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: proj.repoPath,
    stdio: 'pipe',
  })
    .toString()
    .split('\n\n')
    .filter((b) => b.trim()).length;

  console.log(`removing ${created.length} worktrees`);
  const removeSamples: number[] = [];
  let removeFailures = 0;
  const removeWall = nowMs();
  await runPool(created, concurrency, async (wt) => {
    try {
      await timed(removeSamples, () => svc.removeWorktree(wt.path));
    } catch (error) {
      removeFailures++;
      console.log(`remove ${wt.branch} failed: ${(error as Error).message.slice(0, 120)}`);
      throw error;
    }
  });
  // removeWorktree fires its prune without awaiting; settle registrations
  // before deleting branches or git refuses with "checked out at"
  await ctx.exec('git', ['worktree', 'prune']);
  for (const wt of created) {
    try {
      await ctx.exec('git', ['branch', '-D', wt.branch]);
    } catch (error) {
      removeFailures++;
      console.log(`branch -D ${wt.branch} failed: ${(error as Error).message.slice(0, 120)}`);
    }
  }
  const removeWallMs = nowMs() - removeWall;

  const creates = summarize(createSamples);
  const removes = summarize(removeSamples);
  console.log(fmtSummary('checkout', creates));
  console.log(fmtSummary('remove', removes));
  console.log(
    `cold re-derivation: found ${coldFound}/${created.length} in ${coldLookupMs.toFixed(1)}ms; porcelain listed ${porcelain - 1}`
  );
  console.log(
    `checkout throughput: ${((created.length / createWallMs) * 1000).toFixed(2)}/s at requested concurrency ${concurrency}`
  );

  emitResult({
    scenario: 'worktrees',
    profile,
    config: { tasks, concurrency },
    createdOk: created.length,
    failures: { setupFailed, branchNotFound, removeFailures },
    creates,
    removes,
    coldLookup: { found: coldFound, of: created.length, totalMs: Math.round(coldLookupMs) },
    porcelainCount: porcelain - 1,
    checkoutThroughputPerSec: Math.round((created.length / createWallMs) * 1000 * 100) / 100,
    removeThroughputPerSec:
      Math.round(((created.length - removeFailures) / removeWallMs) * 1000 * 100) / 100,
    note: 'service serializes git ops internally; per-op latency includes queue wait',
  });

  dispose();
  proj.cleanup();
  process.exit(created.length === tasks && removeFailures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
