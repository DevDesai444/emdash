// Constructs a WorktreeService against a real repo the same way the app's
// runtime manager does (real LocalExecutionContext + FilesRuntime), with a
// static settings provider — the pattern worktree-service.test.ts uses.
import * as nodePath from 'node:path';
import { contains, FilesRuntime } from '@emdash/core/files';
import { ok } from '@emdash/shared';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import type { ProjectSettingsProvider } from '@main/core/projects/settings/provider';
import { WorktreeService } from '@main/core/projects/worktrees/worktree-service';
import type { IFilesRuntime, RuntimePath } from '@main/core/runtime/types';

const nativePath: RuntimePath = {
  join: (...parts) => nodePath.join(...parts),
  dirname: (p) => nodePath.dirname(p),
  basename: (p) => nodePath.basename(p),
  isAbsolute: (p) => nodePath.isAbsolute(p),
  relative: (from, to) => nodePath.relative(from, to),
  contains,
};

function makeSettings(preservePatterns: string[]): ProjectSettingsProvider {
  return {
    get: async () => ({ preservePatterns }),
    update: async () => ok(),
    patch: async () => ok(),
    ensure: async () => {},
    getDefaultWorktreeDirectory: async () => '',
    getWorktreeDirectory: async () => '',
    getDefaultBranch: async () => 'main',
    getBaseRemote: async () => 'origin',
    getPushRemote: async () => 'origin',
  } as ProjectSettingsProvider;
}

export interface BenchWorktreeSetup {
  svc: WorktreeService;
  ctx: LocalExecutionContext;
  dispose: () => void;
}

export function makeBenchWorktreeService(
  repoPath: string,
  worktreesDir: string,
  preservePatterns: string[] = ['.env']
): BenchWorktreeSetup {
  const ctx = new LocalExecutionContext({ root: repoPath });
  const files = Object.assign(new FilesRuntime(), { path: nativePath }) as IFilesRuntime;
  const svc = new WorktreeService({
    repoPath,
    ctx,
    files,
    projectSettings: makeSettings(preservePatterns),
    resolveWorktreePoolPath: async () => worktreesDir,
  });
  return { svc, ctx, dispose: () => files.dispose() };
}
