import { vi } from 'vitest';

/**
 * The unit suite must never start a real application.
 *
 * Under WSL `getAntigravityExecutablePath()` resolves to the Windows build, and any
 * spawn site that receives it hands the path to Windows through interop: the IDE
 * opens, takes focus and stays open. On 2026-08-14 a single suite run left seven
 * such processes behind, one per version read, and they could not be killed from
 * the Linux side.
 *
 * Every `child_process` entry point is therefore wrapped. A command that names a
 * Windows executable, or Antigravity itself, throws instead of launching, and the
 * message names the command so the offending test is obvious. Everything else is
 * delegated to the real implementation untouched, and a suite that installs its own
 * `child_process` mock keeps overriding this one.
 */

const LAUNCHABLE_APPLICATION = /(\.exe(["']|\s|$))|antigravity/i;

const GUARDED_METHODS = [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
] as const;

function describeCommand(command: unknown): string {
  return typeof command === 'string' ? command : String(command);
}

function guard(methodName: string, actual: (...args: unknown[]) => unknown) {
  return function guarded(...args: unknown[]) {
    const command = describeCommand(args[0]);
    if (LAUNCHABLE_APPLICATION.test(command)) {
      throw new Error(
        `Blocked child_process.${methodName}("${command}") from the unit suite: ` +
          'tests must never launch a real application. Stub the spawn site instead.',
      );
    }
    return actual(...args);
  };
}

function wrapModule(actual: Record<string, unknown>): Record<string, unknown> {
  const wrapped: Record<string, unknown> = { ...actual };
  for (const methodName of GUARDED_METHODS) {
    const original = actual[methodName];
    if (typeof original === 'function') {
      wrapped[methodName] = guard(
        methodName,
        (original as (...a: unknown[]) => unknown).bind(actual),
      );
    }
  }
  wrapped.default = wrapped;
  return wrapped;
}

vi.mock('child_process', async (importActual) => {
  return wrapModule(await importActual<Record<string, unknown>>());
});

vi.mock('node:child_process', async (importActual) => {
  return wrapModule(await importActual<Record<string, unknown>>());
});
