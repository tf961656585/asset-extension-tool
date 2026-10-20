/**
 * 生图凭证读取与旧配置清理（v3.9，spec model-access-architecture-v1 §8）。
 *
 * 凭证键 generation_connection_keys_v1 只允许 background 读取：
 * 渲染层通过 generation-config.ts 的只写函数维护 Key，不得读取明文。
 */

import { GENERATION_CONFIG_KEYS } from '../shared/generation-config';

/** 旧版生图配置键：破坏性更新不迁移，升级后首次初始化只删除。 */
const LEGACY_GENERATION_KEYS = [
  'generation_api_key',
  'generation_api_key_mode',
  'generation_api_keys'
] as const;

/** 按连接 id 读取 API Key；缺失返回空串（由 resolveInvocation 判定 key_missing）。 */
export async function getConnectionKey(connectionId: string): Promise<string> {
  const result = await chrome.storage.local.get(GENERATION_CONFIG_KEYS.keys);
  const keyMap = result[GENERATION_CONFIG_KEYS.keys] as Record<string, string> | undefined;
  const key = keyMap?.[connectionId];
  return typeof key === 'string' ? key : '';
}

/**
 * 删除旧版生图配置键（幂等）。
 * 不触碰新四键 generation_connections_v1 / generation_models_v1 /
 * generation_connection_keys_v1 / generation_last_model_v1。
 */
export async function cleanupLegacyGenerationConfig(): Promise<void> {
  await chrome.storage.local.remove([...LEGACY_GENERATION_KEYS]);
}
