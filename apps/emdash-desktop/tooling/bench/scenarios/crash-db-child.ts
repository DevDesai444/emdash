// Child for the crash scenario: hammer message inserts through the app's db
// until the parent SIGKILLs us mid-write. Prints READY once writes can start.
import { db } from '@main/db/client';
import { initializeDatabase } from '@main/db/initialize';
import { messages } from '@main/db/schema';

const yieldTick = (): Promise<void> => new Promise((res) => setImmediate(res));

async function main(): Promise<void> {
  const convId = process.env.CRASH_CONV_ID;
  if (!convId) throw new Error('CRASH_CONV_ID not set');
  await initializeDatabase(); // migrations already applied by parent; no-op here
  console.log('READY');
  const pad = 'y'.repeat(200);
  for (let i = 0; ; i++) {
    await db.insert(messages).values({
      id: `c-${process.pid}-${i}`,
      conversationId: convId,
      content: `crash write ${i} ${pad}`,
      sender: 'agent',
    });
    if (i % 50 === 49) {
      console.log(`COUNT ${i + 1}`);
      await yieldTick(); // let stdout flush so the parent sees progress
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
