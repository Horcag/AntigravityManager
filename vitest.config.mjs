import { defineConfig } from 'vitest/config';
import os from 'os';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), './src'),
      // Mock native modules that fail to load in test environment
      keytar: path.resolve(process.cwd(), './src/mocks/empty.ts'),
      'better-sqlite3': path.resolve(process.cwd(), './src/mocks/empty.ts'),
      electron: path.resolve(process.cwd(), './src/mocks/electron.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/tests/unit/**/*.test.ts'],
    env: {
      // The logger creates the agent directory when it is imported, which
      // happens in most suites through the modules under test. Point it away
      // from the user's live directory so a unit run cannot write real logs
      // there, and so a suite that pins process.platform cannot resolve the
      // Linux home with the Windows path API and drop a `\home\...` directory
      // into the repository root.
      ANTIGRAVITY_MANAGER_AGENT_DIR: path.join(os.tmpdir(), 'agm-unit-tests', 'agent-dir'),
    },
  },
});
