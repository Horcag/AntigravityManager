import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';

const FUSE_DISABLED = 48;
const FUSE_ENABLED = 49;

const REQUIRED_FUSES = [
  [FuseV1Options.RunAsNode, FUSE_DISABLED],
  [FuseV1Options.EnableCookieEncryption, FUSE_ENABLED],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FUSE_DISABLED],
  [FuseV1Options.EnableNodeCliInspectArguments, FUSE_DISABLED],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FUSE_ENABLED],
  [FuseV1Options.OnlyLoadAppFromAsar, FUSE_ENABLED],
];

function listFilesRecursive(rootDir) {
  if (!existsSync(rootDir)) {
    return [];
  }

  return readdirSync(rootDir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      return listFilesRecursive(entryPath);
    }

    return entry.isFile() ? [entryPath] : [];
  });
}

function findExecutable(packageDir, platform) {
  if (platform === 'darwin') {
    const appName = path.basename(packageDir, '.app');
    const preferred = path.join(packageDir, 'Contents', 'MacOS', appName);
    if (existsSync(preferred)) {
      return preferred;
    }

    return findSingleFile(path.join(packageDir, 'Contents', 'MacOS'), () => true);
  }

  const preferred = path.join(
    packageDir,
    `antigravity-manager${platform === 'win32' ? '.exe' : ''}`,
  );
  if (existsSync(preferred)) {
    return preferred;
  }

  return findSingleFile(
    packageDir,
    (filePath) => platform !== 'win32' || filePath.endsWith('.exe'),
  );
}

function findSingleFile(directory, predicate) {
  if (!existsSync(directory)) {
    throw new Error(`Packaged application directory is missing: ${directory}`);
  }

  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(directory, entry.name))
    .filter(predicate);

  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one Electron executable in ${directory}, found ${candidates.length}`,
    );
  }

  return candidates[0];
}

export function discoverProductionFuseTarget({
  rootDir = process.cwd(),
  platform = process.platform,
} = {}) {
  const appAsars = listFilesRecursive(path.join(rootDir, 'out')).filter((filePath) => {
    return (
      filePath.endsWith(path.join('resources', 'app.asar')) ||
      filePath.endsWith(path.join('Contents', 'Resources', 'app.asar'))
    );
  });

  const packageDirs = appAsars.map((appAsarPath) => {
    return appAsarPath.endsWith(path.join('Contents', 'Resources', 'app.asar'))
      ? path.dirname(path.dirname(path.dirname(appAsarPath)))
      : path.dirname(path.dirname(appAsarPath));
  });

  if (packageDirs.length !== 1) {
    throw new Error(
      `Expected exactly one packaged production app under ${path.join(rootDir, 'out')}, found ${packageDirs.length}`,
    );
  }

  return findExecutable(packageDirs[0], platform);
}

export function validateProductionFuses(fuseConfig) {
  if (fuseConfig.version !== FuseVersion.V1) {
    return [`Expected fuse wire version ${FuseVersion.V1}, got ${fuseConfig.version}`];
  }

  return REQUIRED_FUSES.flatMap(([option, expected]) => {
    const actual = fuseConfig[option];
    return actual === expected
      ? []
      : [`${FuseV1Options[option]} must be ${expected === FUSE_ENABLED ? 'enabled' : 'disabled'}`];
  });
}

export async function auditProductionFuses(options = {}) {
  const executablePath = discoverProductionFuseTarget(options);
  const fuseConfig = await getCurrentFuseWire(executablePath);
  const failures = validateProductionFuses(fuseConfig);

  return { executablePath, failures, ok: failures.length === 0 };
}

async function runCli() {
  const result = await auditProductionFuses();
  console.log(`Production fuse audit: ${result.executablePath}`);

  if (!result.ok) {
    for (const failure of result.failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('PASS required production fuses are hardened');
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  runCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
