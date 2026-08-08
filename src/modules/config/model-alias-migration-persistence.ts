import path from 'node:path';

import { logger } from '@/shared/logging/logger';
import { copyFileIfAbsent, writeJsonFileAtomic } from '@/shared/persistence/atomic-json-file';
import type { AppConfig } from '@/modules/config/types';
import { hasLegacyModelAliasMappings } from '@/modules/config/model-alias-migration';

export const MODEL_ALIAS_MIGRATION_BACKUP_SUFFIX = '.pre-model-alias-migration.json';

export type ModelAliasMigrationOutcome = 'not_needed' | 'persisted' | 'failed';

/** Path of the backup taken next to the config before it is rewritten. */
export function getModelAliasMigrationBackupPath(configPath: string): string {
  const directory = path.dirname(configPath);
  const base = path.basename(configPath, path.extname(configPath));
  return path.join(directory, `${base}${MODEL_ALIAS_MIGRATION_BACKUP_SUFFIX}`);
}

/**
 * Writes the alias migration back to disk once, the first time it actually
 * converts something.
 *
 * Without this the legacy tables stay in the file and `model_aliases` keeps its
 * pre-migration value, so the migration re-runs on every load and anybody
 * editing the file by hand edits keys the app no longer reads. The original
 * file is copied aside first, and a read-only or otherwise unwritable location
 * is logged and tolerated — the in-memory migration is still correct, and a
 * failure here must not stop the app from starting.
 */
export async function persistMigratedModelAliases(
  configPath: string,
  rawProxy: unknown,
  migratedConfig: AppConfig,
): Promise<ModelAliasMigrationOutcome> {
  if (!isProxyWithLegacyMappings(rawProxy)) {
    return 'not_needed';
  }

  try {
    await copyFileIfAbsent(configPath, getModelAliasMigrationBackupPath(configPath));
    await writeJsonFileAtomic(configPath, migratedConfig, { space: 2 });
    logger.info(
      `Config: migrated legacy model mappings into model_aliases and rewrote ${configPath}`,
    );
    return 'persisted';
  } catch (error) {
    logger.warn(
      `Config: kept the model alias migration in memory; ${configPath} could not be rewritten`,
      error,
    );
    return 'failed';
  }
}

function isProxyWithLegacyMappings(rawProxy: unknown): boolean {
  if (typeof rawProxy !== 'object' || rawProxy === null || Array.isArray(rawProxy)) {
    return false;
  }
  return hasLegacyModelAliasMappings(rawProxy as Parameters<typeof hasLegacyModelAliasMappings>[0]);
}
