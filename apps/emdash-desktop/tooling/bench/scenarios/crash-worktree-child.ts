// Child for the crash scenario: check out branch worktrees back to back until
// killed. The parent owns the repo and verifies what a cold service recovers
// from git state afterwards.
import { makeBenchWorktreeService } from '../lib/worktree';

async function main(): Promise<void> {
  const repoPath = process.env.CRASH_REPO;
  const worktreesDir = process.env.CRASH_POOL;
  const count = parseInt(process.env.CRASH_COUNT || '10', 10);
  if (!repoPath || !worktreesDir) throw new Error('CRASH_REPO / CRASH_POOL not set');
  const { svc } = makeBenchWorktreeService(repoPath, worktreesDir);
  const runId = Math.random().toString(36).slice(2, 7);
  console.log('READY');
  for (let i = 0; i < count; i++) {
    const res = await svc.checkoutBranchWorktree(
      { type: 'local', branch: 'main' },
      `bench/crash-${runId}-${i}`,
      { copyPreservedFiles: true }
    );
    if (!res.success) throw new Error(JSON.stringify(res.error));
    console.log(`CREATED ${i + 1}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
