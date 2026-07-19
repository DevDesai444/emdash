// Throwaway git repos for bench runs. Layout:
//   <root>/repo         <- the project
//   <root>/worktrees    <- worktree pool the scenarios point the service at
// No origin remote on purpose — keeps runs hermetic (fetch/push are skipped).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TempProject {
  root: string;
  repoPath: string;
  worktreesDir: string;
  cleanup: () => void;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

export function makeTempProject(name: string): TempProject {
  // realpath matters on macOS: os.tmpdir() is /var/... which symlinks to
  // /private/var/..., and git reports resolved paths
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `emdash-bench-${name}-`)));
  const repoPath = path.join(root, 'repo');
  fs.mkdirSync(repoPath);

  git(repoPath, 'init');
  git(repoPath, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repoPath, 'config', 'user.email', 'bench@localhost');
  git(repoPath, 'config', 'user.name', 'bench');
  git(repoPath, 'config', 'commit.gpgsign', 'false');

  fs.writeFileSync(path.join(repoPath, 'README.txt'), 'bench fixture repo\n');
  fs.mkdirSync(path.join(repoPath, 'src'));
  fs.writeFileSync(path.join(repoPath, 'src', 'index.js'), 'console.log("hello");\n');
  fs.writeFileSync(path.join(repoPath, '.gitignore'), '.env\nnode_modules/\n');
  // a gitignored .env so worktree checkouts exercise the preserved-files copy
  // path (the settings provider in the scenarios lists it as a preserve pattern)
  fs.writeFileSync(path.join(repoPath, '.env'), 'BENCH_SECRET=1\n');

  git(repoPath, 'add', '-A');
  git(repoPath, 'commit', '-m', 'init');
  fs.appendFileSync(path.join(repoPath, 'src', 'index.js'), '// second commit\n');
  git(repoPath, 'add', '-A');
  git(repoPath, 'commit', '-m', 'touch src');

  const worktreesDir = path.join(root, 'worktrees');
  fs.mkdirSync(worktreesDir);

  return {
    root,
    repoPath,
    worktreesDir,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* temp dir, best effort */
      }
    },
  };
}
