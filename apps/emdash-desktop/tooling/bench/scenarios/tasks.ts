// End-to-end task creation: branch worktree checkout plus the task, initial
// conversation, and first message rows — the same persistence shape the task
// provisioning flow writes — against a real migrated database (EMDASH_DB_FILE
// points the app's db singleton at a scratch file; the launcher sets it before
// any import).
import { db } from '@main/db/client';
import { initializeDatabase } from '@main/db/initialize';
import { conversations, messages, projects, tasks as tasksTable } from '@main/db/schema';
import { currentProfile } from '../profiles';
import { emitResult, fmtSummary, nowMs, runPool, summarize, timed } from '../lib/metrics';
import { makeTempProject } from '../lib/repo';
import { makeBenchWorktreeService } from '../lib/worktree';

const PROJECT_ID = 'bench-project';

async function main(): Promise<void> {
  const { name: profile, cfg } = currentProfile();
  const { tasks, concurrency } = cfg.tasksE2e;
  const proj = makeTempProject('tasks');
  const { svc, ctx, dispose } = makeBenchWorktreeService(proj.repoPath, proj.worktreesDir);
  const runId = Math.random().toString(36).slice(2, 7);

  const initStart = nowMs();
  await initializeDatabase();
  const initMs = nowMs() - initStart;
  console.log(`db init (bundled migrations) ${initMs.toFixed(0)}ms`);

  await db.insert(projects).values({ id: PROJECT_ID, name: 'bench', path: proj.repoPath });

  const seg = {
    checkout: [] as number[],
    taskRow: [] as number[],
    conversationRow: [] as number[],
    firstMessage: [] as number[],
    total: [] as number[],
  };
  const created: Array<{ branch: string; path: string }> = [];
  let failures = 0;

  console.log(`running ${tasks} task creations, ${concurrency} requested concurrently`);
  const wallStart = nowMs();
  await runPool(
    Array.from({ length: tasks }, (_, i) => i),
    concurrency,
    async (i) => {
      const t0 = nowMs();
      const branch = `bench/task-${runId}-${i}`;
      try {
        const res = await timed(seg.checkout, () =>
          svc.checkoutBranchWorktree({ type: 'local', branch: 'main' }, branch, {
            copyPreservedFiles: true,
          })
        );
        if (!res.success) throw new Error(JSON.stringify(res.error));
        created.push({ branch, path: res.data });

        const taskId = `task-${runId}-${i}`;
        await timed(seg.taskRow, async () =>
          db.insert(tasksTable).values({
            id: taskId,
            projectId: PROJECT_ID,
            name: `bench task ${i}`,
            status: 'idle',
          })
        );
        const convId = `conv-${runId}-${i}`;
        await timed(seg.conversationRow, async () =>
          db.insert(conversations).values({
            id: convId,
            projectId: PROJECT_ID,
            taskId,
            title: 'main',
            isInitialConversation: true,
          })
        );
        await timed(seg.firstMessage, async () =>
          db.insert(messages).values({
            id: `msg-${runId}-${i}`,
            conversationId: convId,
            content: `bench task ${i}: ${'lorem '.repeat(30)}`,
            sender: 'user',
          })
        );
        seg.total.push(nowMs() - t0);
      } catch (error) {
        failures++;
        console.log(`task ${i} failed: ${(error as Error).message.slice(0, 140)}`);
      }
    }
  );
  const wallMs = nowMs() - wallStart;

  console.log(fmtSummary('e2e total', summarize(seg.total)));
  console.log(fmtSummary('  worktree checkout', summarize(seg.checkout)));
  console.log(fmtSummary('  task row', summarize(seg.taskRow)));
  console.log(fmtSummary('  conversation row', summarize(seg.conversationRow)));
  console.log(fmtSummary('  first message', summarize(seg.firstMessage)));
  console.log(
    `task throughput: ${((seg.total.length / wallMs) * 1000).toFixed(2)}/s at requested concurrency ${concurrency}`
  );

  // teardown
  for (const wt of created) {
    try {
      await svc.removeWorktree(wt.path);
    } catch {
      /* counted below via porcelain? teardown only */
    }
  }
  await ctx.exec('git', ['worktree', 'prune']);
  dispose();

  emitResult({
    scenario: 'tasks',
    profile,
    config: { tasks, concurrency },
    dbInitMs: Math.round(initMs),
    completed: seg.total.length,
    failures,
    e2eTotal: summarize(seg.total),
    segments: {
      worktreeCheckout: summarize(seg.checkout),
      taskRow: summarize(seg.taskRow),
      conversationRow: summarize(seg.conversationRow),
      firstMessage: summarize(seg.firstMessage),
    },
    taskThroughputPerSec: Math.round((seg.total.length / wallMs) * 1000 * 100) / 100,
  });

  proj.cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
