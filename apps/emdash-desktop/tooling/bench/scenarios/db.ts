import { eq } from 'drizzle-orm';
// Sustained persistence load: N writers (think: N live agent conversations)
// appending message rows with a read mixed in every 10 ops. better-sqlite3 is
// synchronous on one connection, so "concurrency" here means interleaved async
// sessions on the event loop — exactly how the main process runs it. WAL is on
// (client.ts sets it), matching production.
import { db, sqlite } from '@main/db/client';
import { initializeDatabase } from '@main/db/initialize';
import { conversations, messages, projects, tasks as tasksTable } from '@main/db/schema';
import { emitResult, fmtSummary, nowMs, summarize, timed } from '../lib/metrics';
import { currentProfile } from '../profiles';

const PROJECT_ID = 'bench-project';

const yieldTick = (): Promise<void> => new Promise((res) => setImmediate(res));

async function main(): Promise<void> {
  const { name: profile, cfg } = currentProfile();
  const { writers, opsPerWriter } = cfg.dbWrites;

  await initializeDatabase();
  const journalMode = String(sqlite.pragma('journal_mode', { simple: true }));
  await db.insert(projects).values({ id: PROJECT_ID, name: 'bench', path: '/tmp/bench-repo' });

  // one task + conversation per writer, like N open agent chats
  const convIds: string[] = [];
  for (let w = 0; w < writers; w++) {
    const taskId = `task-w${w}`;
    await db.insert(tasksTable).values({
      id: taskId,
      projectId: PROJECT_ID,
      name: `writer ${w}`,
      status: 'running',
    });
    const convId = `conv-w${w}`;
    await db
      .insert(conversations)
      .values({ id: convId, projectId: PROJECT_ID, taskId, title: `chat ${w}` });
    convIds.push(convId);
  }

  const writeSamples: number[] = [];
  const readSamples: number[] = [];
  let errors = 0;
  const content = `agent output chunk: ${'tok '.repeat(70)}`; // ~300 bytes

  console.log(`starting ${writers} writers x ${opsPerWriter} ops (journal_mode=${journalMode})`);
  const wallStart = nowMs();
  await Promise.all(
    convIds.map(async (convId, w) => {
      for (let i = 0; i < opsPerWriter; i++) {
        try {
          await timed(writeSamples, async () =>
            db.insert(messages).values({
              id: `m-${w}-${i}`,
              conversationId: convId,
              content,
              sender: i % 2 ? 'agent' : 'user',
            })
          );
          if (i % 10 === 9) {
            await timed(readSamples, async () =>
              db.select().from(messages).where(eq(messages.conversationId, convId)).limit(50)
            );
          }
        } catch (error) {
          errors++;
          if (errors <= 3) console.log(`op failed: ${(error as Error).message.slice(0, 120)}`);
        }
        // yield so writers actually interleave like separate sessions would
        await yieldTick();
      }
    })
  );
  const wallMs = nowMs() - wallStart;
  const totalOps = writeSamples.length + readSamples.length;

  console.log(fmtSummary('insert message', summarize(writeSamples)));
  console.log(fmtSummary('select recent', summarize(readSamples)));
  console.log(
    `${totalOps} ops in ${(wallMs / 1000).toFixed(1)}s -> ${((totalOps / wallMs) * 1000).toFixed(1)} ops/s (errors=${errors})`
  );

  emitResult({
    scenario: 'db',
    profile,
    config: { writers, opsPerWriter },
    journalMode,
    writes: summarize(writeSamples),
    reads: summarize(readSamples),
    opsPerSec: Math.round((totalOps / wallMs) * 1000 * 10) / 10,
    writesPerSec: Math.round((writeSamples.length / wallMs) * 1000 * 10) / 10,
    errors,
    note: 'single synchronous better-sqlite3 connection with WAL — production topology; writers interleave per event-loop tick',
  });
  process.exit(errors === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
