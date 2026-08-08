/**
 * API Proxy Service Page
 * Provides service control, model mapping, and usage examples
 */
import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ipc } from '@/ipc/manager';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAppConfig } from '@/modules/config/hooks/useAppConfig';
import { useCloudAccounts } from '@/modules/cloud-account/hooks/useCloudAccounts';
import { ProxyConfig } from '@/modules/config/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/use-toast';
import { OpenCodeSyncCard } from '@/modules/proxy-gateway/components/OpenCodeSyncCard';
import {
  buildProxyExampleModels,
  isImageProxyExampleModel,
} from '@/modules/proxy-gateway/components/proxy-example-models';
import {
  MODEL_ALIAS_PRESETS,
  applyModelAliasPresetPlan,
  planModelAliasPreset,
  type ModelAliasPreset,
  type ModelAliasPresetPlan,
} from '@/modules/proxy-gateway/components/model-alias-presets';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Loader2,
  Copy,
  CheckCircle,
  Zap,
  Cpu,
  Sparkles,
  BrainCircuit,
  Code,
  Terminal,
  Eye,
  EyeOff,
  ImageIcon,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type ProxyProtocol = 'openai' | 'anthropic';

interface ModelRouteDiagnostic {
  alias: string;
  target: string;
  enabled: boolean;
  source: string;
  wildcard: boolean;
  target_status: 'known' | 'unknown_model' | 'catalog_unavailable';
  accounts: Array<{
    accountId: string;
    exact: boolean;
    resolvedModel: string;
    status: 'unknown' | 'available' | 'unavailable';
  }>;
}

interface ModelRouteDiagnosticsResponse {
  checked_at: string;
  canonical_models: string[];
  data: ModelRouteDiagnostic[];
  recent_misses: Array<{
    model: string;
    count: number;
    lastSeen: number;
  }>;
  recent_failures: Array<{
    accountId: string;
    modelId: string;
    reason: string;
    detectedAt: number;
  }>;
}

function getExampleModelIcon(modelId: string): ReactNode {
  const normalizedId = modelId.toLowerCase();
  if (isImageProxyExampleModel(normalizedId)) {
    return <ImageIcon size={14} />;
  }
  if (normalizedId.includes('claude-opus')) {
    return <BrainCircuit size={14} />;
  }
  if (normalizedId.includes('claude')) {
    return <Sparkles size={14} />;
  }
  if (normalizedId.includes('flash')) {
    return <Zap size={14} />;
  }
  return <Cpu size={14} />;
}

function ProxyPage() {
  const { t } = useTranslation();
  const { config, isLoading, saveConfig } = useAppConfig();
  const { data: cloudAccounts = [] } = useCloudAccounts();
  const { toast } = useToast();

  // Query all available local IPs
  const { data: localIps } = useQuery({
    queryKey: ['system', 'localIps'],
    queryFn: async () => {
      try {
        const ips = await ipc.client.system.get_local_ips();
        return ips as { address: string; name: string; isRecommended: boolean }[];
      } catch (e) {
        console.error('Failed to get local IPs:', e);
        return [{ address: '127.0.0.1', name: 'localhost', isRecommended: false }];
      }
    },
    staleTime: Infinity,
    retry: 3,
  });

  // Selected IP for display (defaults to first recommended or first available)
  const [selectedIp, setSelectedIp] = useState<string>('');

  // Set default selected IP when IPs are loaded
  useEffect(() => {
    if (localIps && localIps.length > 0 && !selectedIp) {
      const recommended = localIps.find((ip) => ip.isRecommended);
      setSelectedIp(recommended?.address || localIps[0].address);
    }
  }, [localIps, selectedIp]);

  // Local state for proxyConfig editing
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig | undefined>(undefined);
  const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false);
  const [presetTarget, setPresetTarget] = useState('');
  const [presetPlan, setPresetPlan] = useState<ModelAliasPresetPlan | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [gatewayError, setGatewayError] = useState<string | null>(null);

  // Sync config.proxy to local state when loaded, and check actual server status
  useEffect(() => {
    if (config) {
      // Check actual server status and sync with config
      const syncServerStatus = async () => {
        try {
          const status = await ipc.client.gateway.status();
          const actualEnabled = status.running;

          // If config says enabled but server not running, or vice versa, sync
          if (config.proxy.enabled !== actualEnabled) {
            const syncedConfig = { ...config.proxy, enabled: actualEnabled };
            setProxyConfig(syncedConfig);
            // Also save the corrected state
            await saveConfig({ ...config, proxy: syncedConfig });
          } else {
            setProxyConfig(config.proxy);
          }
        } catch {
          // If status check fails, just use config value
          setProxyConfig(config.proxy);
        }
      };
      syncServerStatus();
    }
  }, [config, saveConfig]);

  // Helper to update proxyConfig and auto-save
  const updateProxyConfig = async (newProxyConfig: ProxyConfig) => {
    setProxyConfig(newProxyConfig);
    if (config) {
      await saveConfig({ ...config, proxy: newProxyConfig });
    }
  };

  const updateGatewayPort = (value: string) => {
    if (!proxyConfig) {
      return;
    }

    const port = Number.parseInt(value, 10);
    const nextPort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 8045;
    setGatewayError(null);
    updateProxyConfig({ ...proxyConfig, port: nextPort });
  };

  // ===== Usage Examples State =====
  const [selectedProtocol, setSelectedProtocol] = useState<ProxyProtocol>('openai');
  const [activeModelTab, setActiveModelTab] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const exampleModels = useMemo(() => buildProxyExampleModels(cloudAccounts), [cloudAccounts]);
  const visibleExampleModels = useMemo(
    () =>
      selectedProtocol === 'anthropic'
        ? exampleModels.filter((model) => !isImageProxyExampleModel(model.id))
        : exampleModels,
    [exampleModels, selectedProtocol],
  );
  const effectiveModelId = visibleExampleModels.some((model) => model.id === activeModelTab)
    ? activeModelTab
    : (visibleExampleModels[0]?.id ?? 'MODEL_ID');

  // Computed values for examples
  const apiKey = proxyConfig?.api_key || 'YOUR_API_KEY';
  const baseUrl = `http://localhost:${proxyConfig?.port || 8045}`;
  const modelRouteDiagnostics = useQuery<ModelRouteDiagnosticsResponse>({
    queryKey: [
      'gateway',
      'model-routes',
      baseUrl,
      proxyConfig?.api_key,
      proxyConfig?.model_aliases,
    ],
    enabled: Boolean(proxyConfig?.enabled && proxyConfig.api_key),
    retry: false,
    staleTime: 5_000,
    queryFn: async () => {
      const response = await fetch(`${baseUrl}/v1/model-routes`, {
        headers: { Authorization: `Bearer ${proxyConfig?.api_key ?? ''}` },
      });
      if (!response.ok) {
        throw new Error(`Route diagnostics failed with HTTP ${response.status}`);
      }
      return (await response.json()) as ModelRouteDiagnosticsResponse;
    },
  });
  const modelAliasTargets = useMemo(() => {
    const targetIds = new Set(modelRouteDiagnostics.data?.canonical_models ?? []);
    for (const route of proxyConfig?.model_aliases ?? []) {
      if (route.target.trim()) {
        targetIds.add(route.target.trim());
      }
    }
    if (targetIds.size === 0) {
      for (const model of exampleModels) {
        targetIds.add(model.id);
      }
    }
    return [...targetIds].sort((left, right) => left.localeCompare(right));
  }, [exampleModels, modelRouteDiagnostics.data?.canonical_models, proxyConfig?.model_aliases]);

  const updateModelAlias = (
    index: number,
    patch: Partial<ProxyConfig['model_aliases'][number]>,
  ) => {
    if (!proxyConfig) {
      return;
    }
    const modelAliases = proxyConfig.model_aliases.map((route, routeIndex) =>
      routeIndex === index ? { ...route, ...patch } : route,
    );
    const nextConfig = { ...proxyConfig, model_aliases: modelAliases };
    if (modelAliases.every((route) => route.alias.trim() && route.target.trim())) {
      updateProxyConfig(nextConfig);
    } else {
      setProxyConfig(nextConfig);
    }
  };

  const addModelAlias = () => {
    if (!proxyConfig || modelAliasTargets.length === 0) {
      return;
    }
    const usedAliases = new Set(proxyConfig.model_aliases.map((route) => route.alias));
    let aliasIndex = proxyConfig.model_aliases.length + 1;
    while (usedAliases.has(`my-model-${aliasIndex}`)) {
      aliasIndex += 1;
    }
    updateProxyConfig({
      ...proxyConfig,
      model_aliases: [
        ...proxyConfig.model_aliases,
        {
          alias: `my-model-${aliasIndex}`,
          target: modelAliasTargets[0],
          enabled: true,
        },
      ],
    });
  };

  const removeModelAlias = (index: number) => {
    if (!proxyConfig) {
      return;
    }
    updateProxyConfig({
      ...proxyConfig,
      model_aliases: proxyConfig.model_aliases.filter((_, routeIndex) => routeIndex !== index),
    });
  };

  const previewModelAliasPreset = (preset: ModelAliasPreset) => {
    if (!proxyConfig || !presetTarget.trim()) {
      return;
    }
    setPresetPlan(planModelAliasPreset(preset, presetTarget, proxyConfig.model_aliases));
  };

  const applyPresetPlan = () => {
    if (!proxyConfig || !presetPlan || presetPlan.additions.length === 0) {
      return;
    }
    updateProxyConfig({
      ...proxyConfig,
      model_aliases: applyModelAliasPresetPlan(proxyConfig.model_aliases, presetPlan),
    });
    toast({
      title: t('proxy.mapping.presets_applied', {
        added: presetPlan.additions.length,
        skipped: presetPlan.conflicts.length,
      }),
    });
    setPresetPlan(null);
  };

  const createAliasFromMiss = (model: string) => {
    if (!proxyConfig) {
      return;
    }
    if (!model.trim() || modelAliasTargets.length === 0) {
      return;
    }
    const normalizedAlias = model.trim().toLowerCase();
    const existingAliases = new Set(
      proxyConfig.model_aliases.map((route) => route.alias.trim().toLowerCase()),
    );
    if (existingAliases.has(normalizedAlias)) {
      return;
    }
    updateProxyConfig({
      ...proxyConfig,
      model_aliases: [
        ...proxyConfig.model_aliases,
        { alias: model.trim(), target: modelAliasTargets[0], enabled: true },
      ],
    });
  };

  const clearMissJournal = async () => {
    try {
      const response = await fetch(`${baseUrl}/v1/model-routes/miss-journal`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${proxyConfig?.api_key ?? ''}` },
      });
      if (!response.ok) {
        throw new Error(`Clear failed with HTTP ${response.status}`);
      }
      await modelRouteDiagnostics.refetch();
      toast({
        title: t('proxy.mapping.miss_cleared'),
      });
    } catch (error) {
      toast({
        title: t('proxy.mapping.miss_clear_failed'),
        description: error instanceof Error ? error.message : t('proxy.mapping.miss_clear_failed'),
        variant: 'destructive',
      });
    }
  };

  const copyToClipboard = (text: string, type: string) => {
    navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  };

  const getCurlExample = (modelId: string) => {
    if (selectedProtocol === 'anthropic') {
      return `curl ${baseUrl}/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${apiKey}" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "${modelId}",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'`;
    }
    if (isImageProxyExampleModel(modelId)) {
      return `curl ${baseUrl}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "model": "${modelId}",
    "size": "1024x1024",
    "messages": [{"role": "user", "content": "Draw a futuristic city"}]
  }'`;
    }
    return `curl ${baseUrl}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "model": "${modelId}",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`;
  };

  const getPythonExample = (modelId: string) => {
    if (selectedProtocol === 'anthropic') {
      return `from anthropic import Anthropic

client = Anthropic(
    base_url="${baseUrl}",
    api_key="${apiKey}"
)

response = client.messages.create(
    model="${modelId}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}]
)
print(response.content[0].text)`;
    }
    return `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}/v1",
    api_key="${apiKey}"
)

response = client.chat.completions.create(
    model="${modelId}",
    messages=[{"role": "user", "content": "Hello"}]
)
print(response.choices[0].message.content)`;
  };

  if (isLoading || !proxyConfig) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-4xl space-y-5 p-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">{t('proxy.title')}</h2>
        <p className="text-muted-foreground mt-1">{t('proxy.description')}</p>

        {/* Local Access Info Banner */}
        {proxyConfig?.enabled && (
          <div className="mt-4 flex flex-col gap-2 rounded-md border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
            <div className="flex items-center gap-2">
              <div className="font-semibold">{t('proxy.config.local_access')}</div>
              <code className="rounded bg-blue-100 px-1.5 py-0.5 font-mono select-all dark:bg-blue-900/50">
                http://{selectedIp || 'localhost'}:{proxyConfig.port}/v1
              </code>
              {/* IP Selector Dropdown */}
              {localIps && localIps.length > 1 && (
                <Select value={selectedIp} onValueChange={setSelectedIp}>
                  <SelectTrigger className="ml-2 h-7 w-auto min-w-[180px] text-xs">
                    <SelectValue placeholder={t('proxy.config.select_ip')} />
                  </SelectTrigger>
                  <SelectContent>
                    {localIps.map((ip) => (
                      <SelectItem key={ip.address} value={ip.address} className="text-xs">
                        {ip.address} ({ip.name}){ip.isRecommended && ' ★'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {!proxyConfig.api_key && (
              <div className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400">
                {t('proxy.config.no_token_warning')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Service Control Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t('proxy.service.title')}</CardTitle>
              <CardDescription>{t('proxy.service.description')}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <div
                className={`h-3 w-3 rounded-full ${proxyConfig.enabled ? 'animate-pulse bg-green-500' : 'bg-gray-400'}`}
              ></div>
              <span className="text-sm font-medium">
                {proxyConfig.enabled ? t('proxy.service.running') : t('proxy.service.stopped')}
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Start/Stop Button */}
          <div className="flex items-center gap-4">
            <Button
              variant={proxyConfig.enabled ? 'destructive' : 'default'}
              onClick={async () => {
                try {
                  const { ipc } = await import('@/ipc/manager');
                  if (proxyConfig.enabled) {
                    await ipc.client.gateway.stop();
                    setGatewayError(null);
                    updateProxyConfig({ ...proxyConfig, enabled: false });
                    return;
                  }

                  const result = await ipc.client.gateway.start({ port: proxyConfig.port });
                  if (result.success) {
                    setGatewayError(null);
                    updateProxyConfig({ ...proxyConfig, port: result.port, enabled: true });
                    return;
                  }

                  const description =
                    result.reason === 'address-in-use'
                      ? t('proxy.service.port_in_use_description', { port: result.port })
                      : result.message;
                  setGatewayError(description);
                  updateProxyConfig({ ...proxyConfig, enabled: false });
                  toast({
                    title:
                      result.reason === 'address-in-use'
                        ? t('proxy.service.port_in_use_title')
                        : t('proxy.service.start_failed'),
                    description,
                    variant: 'destructive',
                  });
                } catch (error) {
                  const description =
                    error instanceof Error ? error.message : t('proxy.service.start_failed');
                  setGatewayError(description);
                  updateProxyConfig({ ...proxyConfig, enabled: false });
                  toast({
                    title: t('proxy.service.start_failed'),
                    description,
                    variant: 'destructive',
                  });
                }
              }}
            >
              {proxyConfig.enabled ? t('proxy.service.stop') : t('proxy.service.start')}
            </Button>
          </div>
          {gatewayError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
              {gatewayError}
            </div>
          )}

          {/* Port & Timeout Configuration */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="gateway-port">{t('proxy.config.port')}</Label>
              <Input
                id="gateway-port"
                type="number"
                value={proxyConfig.port}
                min={1024}
                max={65535}
                onChange={(e) => updateGatewayPort(e.target.value)}
                disabled={proxyConfig.enabled}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gateway-timeout">{t('proxy.config.timeout')}</Label>
              <Input
                id="gateway-timeout"
                type="number"
                value={proxyConfig.request_timeout}
                onChange={(e) =>
                  updateProxyConfig({
                    ...proxyConfig,
                    request_timeout: parseInt(e.target.value) || 120,
                  })
                }
              />
            </div>
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <Label>{t('proxy.config.api_key')}</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  value={proxyConfig.api_key || ''}
                  readOnly
                  type={showKey ? 'text' : 'password'}
                  className="pr-10 font-mono text-sm"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-0 right-0 h-full px-3 py-2 hover:bg-transparent"
                  onClick={() => setShowKey(!showKey)}
                  title={showKey ? t('proxy.config.hide_key') : t('proxy.config.show_key')}
                >
                  {showKey ? (
                    <EyeOff className="text-muted-foreground h-4 w-4" />
                  ) : (
                    <Eye className="text-muted-foreground h-4 w-4" />
                  )}
                </Button>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigator.clipboard.writeText(proxyConfig.api_key || '')}
              >
                <Copy size={14} className="mr-1" />
                {t('proxy.copy')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setIsRegenerateDialogOpen(true)}>
                {t('proxy.regenerate')}
              </Button>
            </div>
            <Dialog open={isRegenerateDialogOpen} onOpenChange={setIsRegenerateDialogOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t('proxy.regenerateConfirm.title')}</DialogTitle>
                  <DialogDescription>{t('proxy.regenerateConfirm.description')}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsRegenerateDialogOpen(false)}>
                    {t('proxy.regenerateConfirm.cancel')}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={async () => {
                      const { ipc } = await import('@/ipc/manager');
                      const result = await ipc.client.gateway.generateKey();
                      updateProxyConfig({ ...proxyConfig, api_key: result.api_key });
                      setIsRegenerateDialogOpen(false);
                    }}
                  >
                    {t('proxy.regenerateConfirm.confirm')}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          {/* Auto Start Toggle */}
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-1">
              <Label>{t('proxy.config.auto_start')}</Label>
              <p className="text-xs text-gray-500">{t('proxy.config.auto_start_desc')}</p>
            </div>
            <Switch
              checked={proxyConfig.auto_start}
              onCheckedChange={(checked) =>
                updateProxyConfig({ ...proxyConfig, auto_start: checked })
              }
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-1">
              <Label>{t('proxy.config.cloud_code_meta')}</Label>
              <p className="text-xs text-gray-500">{t('proxy.config.cloud_code_meta_desc')}</p>
            </div>
            <Switch
              checked={proxyConfig.experimental.enable_cloud_code_meta}
              onCheckedChange={(checked) =>
                updateProxyConfig({
                  ...proxyConfig,
                  experimental: {
                    ...proxyConfig.experimental,
                    enable_cloud_code_meta: checked,
                  },
                })
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* Model Mapping Card */}
      <Card>
        <CardHeader>
          <CardTitle>{t('proxy.mapping.title')}</CardTitle>
          <CardDescription>{t('proxy.mapping.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {proxyConfig.model_aliases.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-gray-500">
              {t('proxy.mapping.empty')}
            </div>
          ) : (
            <div className="space-y-3">
              {proxyConfig.model_aliases.map((route, index) => {
                const diagnostic = modelRouteDiagnostics.data?.data.find(
                  (item) => item.alias.toLowerCase() === route.alias.toLowerCase(),
                );
                const availableAccounts =
                  diagnostic?.accounts.filter((account) => account.status === 'available').length ??
                  0;
                return (
                  <div key={`${route.alias}-${index}`} className="rounded-lg border p-4">
                    <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto_auto] md:items-end">
                      <div className="space-y-2">
                        <Label>{t('proxy.mapping.alias')}</Label>
                        <Input
                          value={route.alias}
                          placeholder="my-model"
                          onChange={(event) =>
                            updateModelAlias(index, { alias: event.target.value })
                          }
                          onBlur={() => {
                            if (route.alias.trim() && route.target.trim()) {
                              updateProxyConfig(proxyConfig);
                            }
                          }}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{t('proxy.mapping.target')}</Label>
                        <Select
                          value={route.target}
                          onValueChange={(target) => updateModelAlias(index, { target })}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {modelAliasTargets.map((target) => (
                              <SelectItem key={target} value={target}>
                                {target}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex h-10 items-center gap-2">
                        <Switch
                          checked={route.enabled}
                          onCheckedChange={(enabled) => updateModelAlias(index, { enabled })}
                        />
                        <span className="text-xs text-gray-500">
                          {route.enabled ? t('proxy.mapping.enabled') : t('proxy.mapping.disabled')}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('proxy.mapping.remove')}
                        onClick={() => removeModelAlias(index)}
                      >
                        <Trash2 size={16} />
                      </Button>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                      <span>
                        {diagnostic
                          ? t(`proxy.mapping.status_${diagnostic.target_status}`)
                          : t('proxy.mapping.status_unchecked')}
                      </span>
                      {diagnostic ? (
                        <span>
                          · {t('proxy.mapping.available_accounts', { count: availableAccounts })}
                        </span>
                      ) : null}
                      {diagnostic?.wildcard ? <span>· {t('proxy.mapping.wildcard')}</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="space-y-3 rounded-lg border p-4">
            <div>
              <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('proxy.mapping.presets_title')}
              </div>
              <div className="text-xs text-gray-500">{t('proxy.mapping.presets_description')}</div>
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
              <div className="space-y-2">
                <Label>{t('proxy.mapping.presets_target')}</Label>
                <Select value={presetTarget} onValueChange={setPresetTarget}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('proxy.mapping.presets_target_placeholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {modelAliasTargets.map((target) => (
                      <SelectItem key={target} value={target}>
                        {target}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap gap-2">
                {MODEL_ALIAS_PRESETS.map((preset) => (
                  <Button
                    key={preset.id}
                    variant="outline"
                    size="sm"
                    disabled={!presetTarget || modelAliasTargets.length === 0}
                    onClick={() => previewModelAliasPreset(preset)}
                  >
                    <Plus size={14} className="mr-2" />
                    {t(`proxy.mapping.presets_pack_${preset.id}`)} ({preset.aliases.length})
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('proxy.mapping.recent_misses_title')}
            </div>
            {modelRouteDiagnostics.data?.recent_misses &&
            modelRouteDiagnostics.data.recent_misses.length > 0 ? (
              <div className="space-y-2">
                {modelRouteDiagnostics.data.recent_misses.map((miss) => (
                  <div
                    key={miss.model}
                    className="rounded-lg border border-dashed p-3 text-sm text-gray-600 dark:text-gray-300"
                  >
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="font-medium text-gray-800 dark:text-gray-100">
                        <span>{miss.model}</span>
                        <span className="text-gray-500 dark:text-gray-400">
                          {' '}
                          · {t('proxy.mapping.recent_misses_count', { count: miss.count })}
                        </span>
                      </div>
                      <div>
                        {t('proxy.mapping.recent_misses_last_seen', {
                          time: new Date(miss.lastSeen).toLocaleString(),
                        })}
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => createAliasFromMiss(miss.model)}
                        disabled={modelAliasTargets.length === 0}
                      >
                        <Plus size={14} className="mr-2" />
                        {t('proxy.mapping.create_miss_alias')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed p-3 text-sm text-gray-500">
                {t('proxy.mapping.recent_misses_empty')}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-gray-500">
              {modelRouteDiagnostics.data?.checked_at
                ? t('proxy.mapping.checked_at', {
                    time: new Date(modelRouteDiagnostics.data.checked_at).toLocaleTimeString(),
                  })
                : t('proxy.mapping.not_checked')}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!proxyConfig.enabled || modelRouteDiagnostics.isFetching}
                onClick={() => modelRouteDiagnostics.refetch()}
              >
                <RefreshCw
                  size={14}
                  className={modelRouteDiagnostics.isFetching ? 'mr-2 animate-spin' : 'mr-2'}
                />
                {t('proxy.mapping.check')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={modelAliasTargets.length === 0}
                onClick={addModelAlias}
              >
                <Plus size={14} className="mr-2" />
                {t('proxy.mapping.add')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!modelRouteDiagnostics.data?.recent_misses?.length}
                onClick={clearMissJournal}
              >
                {t('proxy.mapping.clear_misses')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  proxyConfig.model_aliases.length === 0 &&
                  Object.keys(proxyConfig.custom_mapping).length === 0 &&
                  Object.keys(proxyConfig.anthropic_mapping).length === 0
                }
                onClick={() =>
                  updateProxyConfig({
                    ...proxyConfig,
                    model_aliases: [],
                    custom_mapping: {},
                    anthropic_mapping: {},
                  })
                }
              >
                {t('proxy.mapping.clear')}
              </Button>
            </div>
          </div>

          <Dialog
            open={presetPlan !== null}
            onOpenChange={(open) => {
              if (!open) {
                setPresetPlan(null);
              }
            }}
          >
            <DialogContent>
              {presetPlan ? (
                <>
                  <DialogHeader>
                    <DialogTitle>
                      {t('proxy.mapping.presets_preview_title', {
                        pack: t(`proxy.mapping.presets_pack_${presetPlan.presetId}`),
                      })}
                    </DialogTitle>
                    <DialogDescription>
                      {t('proxy.mapping.presets_preview_description', {
                        target: presetPlan.target,
                      })}
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 text-sm">
                    <div className="space-y-1">
                      <div className="font-medium text-gray-800 dark:text-gray-100">
                        {t('proxy.mapping.presets_preview_additions')} (
                        {presetPlan.additions.length})
                      </div>
                      {presetPlan.additions.length > 0 ? (
                        <ul className="space-y-1 text-gray-600 dark:text-gray-300">
                          {presetPlan.additions.map((row) => (
                            <li key={row.alias}>
                              {row.alias} → {row.target}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="text-gray-500">
                          {t('proxy.mapping.presets_preview_nothing')}
                        </div>
                      )}
                    </div>
                    {presetPlan.conflicts.length > 0 ? (
                      <div className="space-y-1">
                        <div className="font-medium text-gray-800 dark:text-gray-100">
                          {t('proxy.mapping.presets_preview_conflicts')} (
                          {presetPlan.conflicts.length})
                        </div>
                        <ul className="space-y-1 text-gray-600 dark:text-gray-300">
                          {presetPlan.conflicts.map((conflict) => (
                            <li key={conflict.alias}>
                              {conflict.alias} → {conflict.existingTarget}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setPresetPlan(null)}>
                      {t('proxy.mapping.presets_cancel')}
                    </Button>
                    <Button disabled={presetPlan.additions.length === 0} onClick={applyPresetPlan}>
                      {t('proxy.mapping.presets_apply')}
                    </Button>
                  </DialogFooter>
                </>
              ) : null}
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>

      <OpenCodeSyncCard baseUrl={baseUrl} models={exampleModels} />

      {/* Usage Examples Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Code size={20} />
            {t('proxy.examples.title')}
          </CardTitle>
          <CardDescription>{t('proxy.examples.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Protocol Selector Cards */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* OpenAI Protocol Card */}
            <div
              className={`cursor-pointer rounded-lg border-2 bg-gradient-to-br from-blue-50 to-blue-100/50 p-4 transition-all dark:from-blue-950/30 dark:to-blue-900/20 ${selectedProtocol === 'openai' ? 'border-blue-500 shadow-md dark:border-blue-600' : 'border-blue-200 hover:border-blue-300 dark:border-blue-800/50'}`}
              onClick={() => setSelectedProtocol('openai')}
            >
              <div className="mb-3 flex items-center gap-2">
                <div
                  className={`h-2 w-2 rounded-full ${selectedProtocol === 'openai' ? 'animate-pulse bg-blue-500' : 'bg-blue-400'}`}
                ></div>
                <span className="text-sm font-bold text-blue-700 dark:text-blue-400">
                  {t('settings.examples.openai_protocol')}
                </span>
              </div>
              <div className="mb-2 rounded border border-blue-200/50 bg-white/60 px-3 py-2 dark:border-blue-700/30 dark:bg-gray-800/40">
                <code className="font-mono text-xs break-all text-gray-800 dark:text-gray-200">
                  POST /v1/chat/completions
                </code>
              </div>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {t('settings.examples.openai_tools')}
              </p>
            </div>

            {/* Anthropic Protocol Card */}
            <div
              className={`cursor-pointer rounded-lg border-2 bg-gradient-to-br from-purple-50 to-purple-100/50 p-4 transition-all dark:from-purple-950/30 dark:to-purple-900/20 ${selectedProtocol === 'anthropic' ? 'border-purple-500 shadow-md dark:border-purple-600' : 'border-purple-200 hover:border-purple-300 dark:border-purple-800/50'}`}
              onClick={() => setSelectedProtocol('anthropic')}
            >
              <div className="mb-3 flex items-center gap-2">
                <div
                  className={`h-2 w-2 rounded-full ${selectedProtocol === 'anthropic' ? 'animate-pulse bg-purple-500' : 'bg-purple-400'}`}
                ></div>
                <span className="text-sm font-bold text-purple-700 dark:text-purple-400">
                  {t('settings.examples.anthropic_protocol')}
                </span>
              </div>
              <div className="mb-2 rounded border border-purple-200/50 bg-white/60 px-3 py-2 dark:border-purple-700/30 dark:bg-gray-800/40">
                <code className="font-mono text-xs break-all text-gray-800 dark:text-gray-200">
                  POST /v1/messages
                </code>
              </div>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {t('settings.examples.anthropic_tools')}
              </p>
            </div>
          </div>

          {/* Model Tabs */}
          <div className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-700">
            {visibleExampleModels.map((model) => (
              <button
                key={model.id}
                onClick={() => setActiveModelTab(model.id)}
                className={`flex items-center gap-1 rounded-t-lg px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${effectiveModelId === model.id ? 'border-b-2 border-blue-600 bg-blue-50/50 text-blue-600 dark:border-blue-400 dark:bg-blue-900/10 dark:text-blue-400' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800'}`}
              >
                {getExampleModelIcon(model.id)}
                <span>{model.name}</span>
              </button>
            ))}
          </div>

          {/* cURL Example */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                <Terminal size={16} />
                cURL
              </span>
              <button
                onClick={() => copyToClipboard(getCurlExample(effectiveModelId), 'curl')}
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
              >
                {copied === 'curl' ? <CheckCircle size={14} /> : <Copy size={14} />}
                {copied === 'curl' ? t('proxy.copied') : t('proxy.copy')}
              </button>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-gray-900 p-3 font-mono text-xs whitespace-pre-wrap text-gray-100">
              {getCurlExample(effectiveModelId)}
            </pre>
          </div>

          {/* Python Example */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                <Code size={16} />
                Python
              </span>
              <button
                onClick={() => copyToClipboard(getPythonExample(effectiveModelId), 'python')}
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
              >
                {copied === 'python' ? <CheckCircle size={14} /> : <Copy size={14} />}
                {copied === 'python' ? t('proxy.copied') : t('proxy.copy')}
              </button>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-gray-900 p-3 font-mono text-xs whitespace-pre-wrap text-gray-100">
              {getPythonExample(effectiveModelId)}
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute('/proxy')({
  component: ProxyPage,
});
