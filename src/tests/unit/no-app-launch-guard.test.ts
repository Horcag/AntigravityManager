import { describe, expect, it } from 'vitest';

import { execFile, execSync, spawn, spawnSync } from 'child_process';

/**
 * Pins the guard installed by `src/tests/support/no-app-launch.setup.ts`.
 *
 * Without it a suite that reaches a spawn site under WSL starts the Windows build of
 * Antigravity through interop, which opens a window, steals focus and survives the
 * run. The guard has to hold for every entry point, because the launch sites in
 * `antigravity-runtime` do not all use the same one.
 */
describe('unit suite cannot launch an application', () => {
  const windowsExecutable = '/mnt/c/Windows/System32/cmd.exe';

  it('blocks spawn of a Windows executable', () => {
    expect(() => spawn(windowsExecutable, ['/c', 'echo', 'hi'])).toThrow(/Blocked child_process/);
  });

  it('blocks spawnSync, execFile and execSync alike', () => {
    expect(() => spawnSync(windowsExecutable, ['/c', 'echo', 'hi'])).toThrow(
      /Blocked child_process/,
    );
    expect(() => execFile(windowsExecutable, ['/c', 'echo', 'hi'])).toThrow(
      /Blocked child_process/,
    );
    expect(() => execSync(`${windowsExecutable} /c echo hi`)).toThrow(/Blocked child_process/);
  });

  it('blocks the Antigravity executable by name on any platform', () => {
    expect(() =>
      spawn('C:\\Users\\someone\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe', []),
    ).toThrow(/Blocked child_process/);
    expect(() => spawn('/usr/share/antigravity/antigravity', [])).toThrow(/Blocked child_process/);
  });

  it('leaves an ordinary command alone', () => {
    const result = spawnSync('/bin/echo', ['hi'], { encoding: 'utf8' });
    expect(result.stdout.trim()).toBe('hi');
  });
});
