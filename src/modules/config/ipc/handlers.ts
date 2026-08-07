import { AppConfig } from '@/modules/config/types';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { syncAutoStart } from '@/modules/antigravity-runtime/utils/autoStart';
import { logger } from '@/shared/logging/logger';
import { setServerConfig } from '@/server/server-config';

export function loadConfig(): AppConfig {
  return ConfigManager.loadConfig();
}

export async function saveConfig(config: AppConfig): Promise<void> {
  // Logic to notify proxy server if configuration changes (hot update)
  // Logic to update Tray if language changes
  // For now just save
  const previous = ConfigManager.getCachedConfig() ?? ConfigManager.loadConfig();
  await ConfigManager.saveConfig(config);
  const savedConfig = ConfigManager.getCachedConfig() ?? config;
  setServerConfig(savedConfig.proxy);
  logger.setErrorReportingEnabled(savedConfig.error_reporting_enabled);
  if (previous.auto_startup !== savedConfig.auto_startup) {
    syncAutoStart(savedConfig);
  }
}
