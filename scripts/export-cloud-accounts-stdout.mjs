import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import process from 'process';

const rootDir = process.cwd();
const platform = process.platform;
const arch = process.arch;
const executableName = platform === 'win32' ? 'antigravity-manager.exe' : 'antigravity-manager';
const packageDir = path.join(rootDir, 'out', `Antigravity Manager-${platform}-${arch}`);
const executablePath = path.join(packageDir, executableName);

if (!fs.existsSync(executablePath)) {
  process.stderr.write(
    `Packaged Antigravity Manager executable was not found at ${executablePath}. Run "npm run package" first.\n`,
  );
  process.exit(1);
}

const child = spawn(executablePath, ['--export-cloud-accounts-with-tokens-stdout'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
});

child.on('error', (error) => {
  process.stderr.write(`Failed to start packaged Antigravity Manager exporter: ${error.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`Packaged Antigravity Manager exporter exited from signal ${signal}\n`);
    process.exit(1);
  }

  process.exit(code ?? 1);
});
