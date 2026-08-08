import { z } from 'zod';
import {
  DeviceProfileSchema,
  DeviceProfileVersionSchema,
  type DeviceProfile,
  type DeviceProfileVersion,
} from '@/modules/identity-profile/types';

export interface CloudTokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expiry_timestamp: number;
  token_type: string;
  email?: string;
  project_id?: string;
  oauth_client_key?: string;
  session_id?: string;
  id_token?: string;
  upstream_proxy_url?: string;
  is_gcp_tos?: boolean;
}

export interface CloudQuotaModelInfo {
  percentage: number;
  resetTime: string;
  display_name?: string;
  supports_images?: boolean;
  supports_thinking?: boolean;
  thinking_budget?: number;
  recommended?: boolean;
  max_tokens?: number;
  max_output_tokens?: number;
  supported_mime_types?: Record<string, boolean>;
  /** `ModelDetails.is_internal`: provider-internal model, not offered in the IDE picker. */
  is_internal?: boolean;
  /** `ModelDetails.disabled`: advertised but turned off for this account. */
  disabled?: boolean;
  /**
   * `ModelDetails.supports_cumulative_context`: the editor keeps feeding the
   * same growing buffer back. One of the editor-family markers.
   */
  supports_cumulative_context?: boolean;
  /**
   * `ModelDetails.supports_estimate_token_counter`: the editor sizes its own
   * prompt locally instead of asking the provider. Editor-family marker.
   */
  supports_estimate_token_counter?: boolean;
  /**
   * `ModelDetails.requires_lead_in_generation`: generation must be primed with
   * the text before the cursor. Editor-family marker.
   */
  requires_lead_in_generation?: boolean;
  beta?: boolean;
  preview?: boolean;
  supports_video?: boolean;
  supports_pdf?: boolean;
  tokenizer_type?: string;
  vertex_model_id?: string;
}

/**
 * Surface partitioning carried by `v1internal:fetchAvailableModels`
 * (`FetchAvailableModelsResponse`, `google/internal/cloud/code/v1internal/model_configs.proto`).
 * Each entry lists the provider model ids the IDE is allowed to use for that
 * surface; `agent` is flattened from `agent_model_sorts[].groups[].model_ids`
 * and is the only chat-shaped role. Every key is optional because different
 * accounts and provider versions return different subsets.
 */
export interface CloudModelRoles {
  agent?: string[];
  command?: string[];
  tab?: string[];
  image_generation?: string[];
  mquery?: string[];
  web_search?: string[];
  commit_message?: string[];
  audio_transcription?: string[];
}

export type CloudModelRoleId = keyof CloudModelRoles;

export interface CloudQuotaData {
  models: Record<string, CloudQuotaModelInfo>;
  model_forwarding_rules?: Record<string, string>;
  subscription_tier?: string;
  is_forbidden?: boolean;
  isForbidden?: boolean;
  ai_credits?: { credits: number; expiryDate: string };
  quota_groups?: CloudQuotaGroup[];
  model_roles?: CloudModelRoles;
  default_agent_model_id?: string;
}

export interface CloudQuotaBucket {
  bucket_id: string;
  window: string;
  remaining_fraction: number;
  reset_time: string;
  display_name?: string;
  description?: string;
}

export interface CloudQuotaGroup {
  display_name: string;
  description?: string;
  buckets: CloudQuotaBucket[];
}

export interface CloudAccount {
  id: string; // UUID
  provider: 'google' | 'anthropic';
  email: string;
  name?: string | null;
  avatar_url?: string | null;
  token: CloudTokenData;
  quota?: CloudQuotaData;
  device_profile?: DeviceProfile;
  device_history?: DeviceProfileVersion[];
  created_at: number;
  last_used: number; // Unix timestamp
  status?: 'active' | 'rate_limited' | 'expired';
  status_reason?: string;
  is_active?: boolean;
  is_active_classic?: boolean;
  is_active_ide?: boolean;
  is_active_agy?: boolean;
  proxy_url?: string;
}

// Zod Schemas
export const CloudTokenDataSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  expiry_timestamp: z.number(),
  token_type: z.string(),
  email: z.string().optional(),
  project_id: z.string().optional(),
  oauth_client_key: z.string().optional(),
  session_id: z.string().optional(),
  id_token: z.string().optional(),
  upstream_proxy_url: z.string().optional(),
  is_gcp_tos: z.boolean().optional(),
});

export const CloudQuotaModelInfoSchema = z.object({
  percentage: z.number(),
  resetTime: z.string(),
  display_name: z.string().optional(),
  supports_images: z.boolean().optional(),
  supports_thinking: z.boolean().optional(),
  thinking_budget: z.number().optional(),
  recommended: z.boolean().optional(),
  max_tokens: z.number().optional(),
  max_output_tokens: z.number().optional(),
  supported_mime_types: z.record(z.string(), z.boolean()).optional(),
  is_internal: z.boolean().optional(),
  disabled: z.boolean().optional(),
  supports_cumulative_context: z.boolean().optional(),
  supports_estimate_token_counter: z.boolean().optional(),
  requires_lead_in_generation: z.boolean().optional(),
  beta: z.boolean().optional(),
  preview: z.boolean().optional(),
  supports_video: z.boolean().optional(),
  supports_pdf: z.boolean().optional(),
  tokenizer_type: z.string().optional(),
  vertex_model_id: z.string().optional(),
});

export const CloudModelRolesSchema = z.object({
  agent: z.array(z.string()).optional(),
  command: z.array(z.string()).optional(),
  tab: z.array(z.string()).optional(),
  image_generation: z.array(z.string()).optional(),
  mquery: z.array(z.string()).optional(),
  web_search: z.array(z.string()).optional(),
  commit_message: z.array(z.string()).optional(),
  audio_transcription: z.array(z.string()).optional(),
});

export const CloudQuotaBucketSchema = z.object({
  bucket_id: z.string(),
  window: z.string(),
  remaining_fraction: z.number(),
  reset_time: z.string(),
  display_name: z.string().optional(),
  description: z.string().optional(),
});

export const CloudQuotaGroupSchema = z.object({
  display_name: z.string(),
  description: z.string().optional(),
  buckets: z.array(CloudQuotaBucketSchema),
});

export const CloudQuotaDataSchema = z.object({
  models: z.record(z.string(), CloudQuotaModelInfoSchema),
  model_forwarding_rules: z.record(z.string(), z.string()).optional(),
  subscription_tier: z.string().optional(),
  is_forbidden: z.boolean().optional(),
  isForbidden: z.boolean().optional(),
  ai_credits: z.object({ credits: z.number(), expiryDate: z.string() }).optional(),
  quota_groups: z.array(CloudQuotaGroupSchema).optional(),
  model_roles: CloudModelRolesSchema.optional(),
  default_agent_model_id: z.string().optional(),
});

export const CloudAccountSchema = z.object({
  id: z.string(),
  provider: z.enum(['google', 'anthropic']),
  email: z.string(), // Relaxed: was z.string().email() but caused validation issues with some formats
  name: z.string().optional().nullable(),
  avatar_url: z.string().optional().nullable(),
  token: CloudTokenDataSchema,
  quota: CloudQuotaDataSchema.optional(),
  device_profile: DeviceProfileSchema.optional(),
  device_history: z.array(DeviceProfileVersionSchema).optional(),
  created_at: z.number(),
  last_used: z.number(),
  status: z.enum(['active', 'rate_limited', 'expired']).optional(),
  status_reason: z.string().optional(),
  is_active: z.boolean().optional(),
  is_active_classic: z.boolean().optional(),
  is_active_ide: z.boolean().optional(),
  is_active_agy: z.boolean().optional(),
  proxy_url: z.string().optional(),
});

export const CloudAccountExportSchema = z.object({
  version: z.literal('1.0'),
  exportedAt: z.number(),
  accounts: z.array(
    z.object({
      provider: z.enum(['google', 'anthropic']),
      email: z.string(),
      name: z.string().optional().nullable(),
      avatar_url: z.string().optional().nullable(),
      token: CloudTokenDataSchema.optional(),
      quota: CloudQuotaDataSchema.optional(),
      device_profile: z.any().optional(),
      device_history: z.any().optional(),
      proxy_url: z.string().optional().nullable(),
      status: z.enum(['active', 'rate_limited', 'expired']).optional(),
      status_reason: z.string().optional(),
    }),
  ),
});

export type CloudAccountExport = z.infer<typeof CloudAccountExportSchema>;
