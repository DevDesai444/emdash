// Minimal electron stand-in so main-process modules can load outside the app.
// Mirrors what the vitest suites do with vi.mock('electron', ...). Everything
// that matters funnels through app.getPath/app.getAppPath; the rest are inert.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const scratch = process.env.BENCH_SCRATCH || path.join(os.tmpdir(), 'emdash-bench');

function scratchDir(name: string): string {
  const dir = path.join(scratch, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const app = {
  // userData and friends all point into the bench scratch dir so a run can
  // never touch real app state
  getPath: (name: string) => scratchDir(name || 'misc'),
  // the launcher always sets cwd to apps/emdash-desktop, so drizzle/ resolves
  getAppPath: () => process.cwd(),
  getName: () => 'emdash-bench',
  getVersion: () => '0.0.0-bench',
  isPackaged: false,
};

export const BrowserWindow = {
  getAllWindows: (): unknown[] => [],
};

export class Notification {
  static isSupported(): boolean {
    return false;
  }
}

export const ipcMain = {
  handle: (): void => undefined,
  on: (): void => undefined,
  removeHandler: (): void => undefined,
};

export const shell = {
  openExternal: async (): Promise<void> => undefined,
};

export default { app, BrowserWindow, Notification, ipcMain, shell };
