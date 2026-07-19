// Workload profiles. 'standard' is sized around a realistic upper bound of
// parallel agent tasks on one machine; 'heavy' pushes past it to find where
// things degrade.

export interface Profile {
  worktrees: { tasks: number; concurrency: number };
  dbWrites: { writers: number; opsPerWriter: number };
  tasksE2e: { tasks: number; concurrency: number };
  pty: { sessions: number; lineRate: number; lines: number; lineBytes: number };
  crash: {
    dbKills: number;
    killDelayMsMin: number;
    killDelayMsMax: number;
    worktreeKills: number;
    worktreesPerKill: number;
  };
}

export const PROFILES: Record<string, Profile> = {
  light: {
    worktrees: { tasks: 6, concurrency: 2 },
    dbWrites: { writers: 4, opsPerWriter: 40 },
    tasksE2e: { tasks: 6, concurrency: 2 },
    pty: { sessions: 4, lineRate: 50, lines: 250, lineBytes: 120 },
    crash: {
      dbKills: 4,
      killDelayMsMin: 200,
      killDelayMsMax: 900,
      worktreeKills: 2,
      worktreesPerKill: 6,
    },
  },
  standard: {
    worktrees: { tasks: 42, concurrency: 21 },
    dbWrites: { writers: 21, opsPerWriter: 80 },
    tasksE2e: { tasks: 21, concurrency: 7 },
    pty: { sessions: 21, lineRate: 120, lines: 1200, lineBytes: 160 },
    crash: {
      dbKills: 12,
      killDelayMsMin: 200,
      killDelayMsMax: 1500,
      worktreeKills: 3,
      worktreesPerKill: 10,
    },
  },
  heavy: {
    worktrees: { tasks: 84, concurrency: 28 },
    dbWrites: { writers: 40, opsPerWriter: 120 },
    tasksE2e: { tasks: 42, concurrency: 14 },
    pty: { sessions: 40, lineRate: 400, lines: 4000, lineBytes: 200 },
    crash: {
      dbKills: 25,
      killDelayMsMin: 200,
      killDelayMsMax: 1500,
      worktreeKills: 5,
      worktreesPerKill: 12,
    },
  },
};

export function currentProfile(): { name: string; cfg: Profile } {
  const name = process.env.BENCH_PROFILE || 'standard';
  const cfg = PROFILES[name];
  if (!cfg) throw new Error(`unknown profile '${name}'`);
  return { name, cfg };
}
