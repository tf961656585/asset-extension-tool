/**
 * 生图服务连接与模型记录（v3.9，spec model-access-architecture-v1 §5–§8）。
 *
 * 存储四键：
 * - generation_connections_v1：连接元数据（不含 Key）
 * - generation_models_v1：模型记录
 * - generation_connection_keys_v1：{ [connectionId]: apiKey }（仅 background 读取）
 * - generation_last_model_v1：上次使用的模型记录 id
 *
 * 本文件不导出“读 Key”函数：渲染层只读写连接/模型元数据，Key 写入是只写操作；
 * 执行层读取 Key 走 background/credentials.ts。
 */

import { getProtocol, isProtocolId, type ProtocolId } from './protocols';

export const GENERATION_CONFIG_KEYS = {
  connections: 'generation_connections_v1',
  models: 'generation_models_v1',
  keys: 'generation_connection_keys_v1',
  lastModel: 'generation_last_model_v1'
} as const;

export interface ProviderConnection {
  id: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface GenerationModelRecord {
  id: string;
  connectionId: string;
  protocolId: ProtocolId;
  remoteModelId: string;
  displayName: string;
  supportsReferenceImage: boolean;
  maxRefs: number;
  maxN: number;
  createdAt: number;
}

export interface GenerationConfig {
  connections: ProviderConnection[];
  models: GenerationModelRecord[];
  lastModelId: string | null;
}

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function readStorage<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function writeStorage(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

async function loadConnections(): Promise<ProviderConnection[]> {
  return asArray<ProviderConnection>(await readStorage(GENERATION_CONFIG_KEYS.connections));
}

async function saveConnections(connections: ProviderConnection[]): Promise<void> {
  await writeStorage(GENERATION_CONFIG_KEYS.connections, connections);
}

async function loadModels(): Promise<GenerationModelRecord[]> {
  return asArray<GenerationModelRecord>(await readStorage(GENERATION_CONFIG_KEYS.models));
}

async function saveModels(models: GenerationModelRecord[]): Promise<void> {
  await writeStorage(GENERATION_CONFIG_KEYS.models, models);
}

async function loadKeyMap(): Promise<Record<string, string>> {
  const value = await readStorage<Record<string, string>>(GENERATION_CONFIG_KEYS.keys);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function loadLastModelId(): Promise<string | null> {
  const value = await readStorage<string>(GENERATION_CONFIG_KEYS.lastModel);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function saveLastModelId(id: string | null): Promise<void> {
  await writeStorage(GENERATION_CONFIG_KEYS.lastModel, id);
}

/**
 * 读取连接元数据、模型记录与上次使用模型指针。
 * 不读取 generation_connection_keys_v1；lastModelId 指向不存在的模型时返回 null（不自动改盘）。
 */
export async function loadGenerationConfig(): Promise<GenerationConfig> {
  const [connections, models, storedLastModelId] = await Promise.all([
    loadConnections(),
    loadModels(),
    loadLastModelId()
  ]);

  const lastModelId =
    storedLastModelId && models.some((model) => model.id === storedLastModelId)
      ? storedLastModelId
      : null;

  return { connections, models, lastModelId };
}

/** 按连接分组（保留无模型的连接，供设置页展示模型数量与空态）。 */
export function groupModelsByConnection(
  config: GenerationConfig
): Array<{ connection: ProviderConnection; models: GenerationModelRecord[] }> {
  return config.connections.map((connection) => ({
    connection,
    models: config.models.filter((model) => model.connectionId === connection.id)
  }));
}

export function findModel(
  config: GenerationConfig,
  id: string
): GenerationModelRecord | undefined {
  return config.models.find((model) => model.id === id);
}

export function findConnection(
  config: GenerationConfig,
  id: string
): ProviderConnection | undefined {
  return config.connections.find((connection) => connection.id === id);
}

/**
 * Base URL 规范化（spec §5.2）：trim → 绝对 URL → https → 禁止用户名/密码/query/fragment
 * → 去掉末尾所有 `/` → 保留 path。失败抛中文 Error。
 */
export function normalizeBaseUrl(input: string): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) {
    throw new Error('Base URL 不能为空');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Base URL 必须是完整的绝对地址（如 https://api.example.com/v1）');
  }

  if (url.protocol !== 'https:') {
    throw new Error('Base URL 必须使用 HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('Base URL 不能包含用户名或密码');
  }
  if (url.search) {
    throw new Error('Base URL 不能包含查询参数');
  }
  if (url.hash) {
    throw new Error('Base URL 不能包含片段标识');
  }

  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

function requireTrimmed(value: unknown, errorMessage: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw new Error(errorMessage);
  }
  return trimmed;
}

function validateConnectionName(name: string): string {
  if (name.length < 1 || name.length > 40) {
    throw new Error('连接名称需为 1–40 个字符');
  }
  return name;
}

function assertUniqueConnectionName(
  connections: ProviderConnection[],
  name: string,
  excludeId?: string
): void {
  const normalized = name.toLowerCase();
  const duplicate = connections.some(
    (connection) =>
      connection.id !== excludeId && connection.name.trim().toLowerCase() === normalized
  );
  if (duplicate) {
    throw new Error('连接名称已存在，请更换一个名称');
  }
}

function requireApiKey(apiKey: string): string {
  const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!trimmed) {
    throw new Error('API Key 不能为空');
  }
  return trimmed;
}

async function writeConnectionKey(connectionId: string, apiKey: string): Promise<void> {
  const keyMap = await loadKeyMap();
  keyMap[connectionId] = apiKey;
  await writeStorage(GENERATION_CONFIG_KEYS.keys, keyMap);
}

async function removeConnectionKey(connectionId: string): Promise<void> {
  const keyMap = await loadKeyMap();
  if (!(connectionId in keyMap)) {
    return;
  }
  delete keyMap[connectionId];
  await writeStorage(GENERATION_CONFIG_KEYS.keys, keyMap);
}

async function setConnectionHasKey(
  connectionId: string,
  hasKey: boolean
): Promise<ProviderConnection | undefined> {
  const connections = await loadConnections();
  let updated: ProviderConnection | undefined;
  const next = connections.map((connection) => {
    if (connection.id !== connectionId) {
      return connection;
    }
    updated = { ...connection, hasKey, updatedAt: Date.now() };
    return updated;
  });
  if (updated) {
    await saveConnections(next);
  }
  return updated;
}

/**
 * 新建连接：先写连接元数据（hasKey=false），再写 Key 并同步 hasKey=true。
 * Key 写失败时保留连接并抛错（用户可进入详情页更换 Key）。
 */
export async function createConnection(input: {
  name?: string;
  baseUrl: string;
  apiKey: string;
}): Promise<ProviderConnection> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const key = requireApiKey(input.apiKey);

  const connections = await loadConnections();
  const requestedName = typeof input.name === 'string' ? input.name.trim() : '';
  const name = validateConnectionName(
    requestedName || new URL(baseUrl).hostname
  );
  assertUniqueConnectionName(connections, name);

  const now = Date.now();
  const connection: ProviderConnection = {
    id: createId('conn'),
    name,
    baseUrl,
    hasKey: false,
    createdAt: now,
    updatedAt: now
  };

  await saveConnections([...connections, connection]);

  let savedConnection: ProviderConnection | undefined;
  try {
    await writeConnectionKey(connection.id, key);
    savedConnection = await setConnectionHasKey(connection.id, true);
  } catch {
    throw new Error('API Key 保存失败，连接已创建但未保存 Key，请在详情页重试。');
  }

  return savedConnection ?? { ...connection, hasKey: true };
}

export async function updateConnection(
  id: string,
  patch: { name?: string; baseUrl?: string }
): Promise<void> {
  const connections = await loadConnections();
  const existing = connections.find((connection) => connection.id === id);
  if (!existing) {
    throw new Error('服务商连接不存在');
  }

  let name = existing.name;
  if (patch.name !== undefined) {
    name = validateConnectionName(requireTrimmed(patch.name, '连接名称不能为空'));
    assertUniqueConnectionName(connections, name, id);
  }

  const baseUrl =
    patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : existing.baseUrl;

  await saveConnections(
    connections.map((connection) =>
      connection.id === id
        ? { ...connection, name, baseUrl, updatedAt: Date.now() }
        : connection
    )
  );
}

/** 更换 Key（只写凭证表并同步 hasKey=true）；旧 Key 立即失效。 */
export async function replaceConnectionKey(id: string, apiKey: string): Promise<void> {
  const connections = await loadConnections();
  if (!connections.some((connection) => connection.id === id)) {
    throw new Error('服务商连接不存在');
  }
  const key = requireApiKey(apiKey);
  await writeConnectionKey(id, key);
  await setConnectionHasKey(id, true);
}

/**
 * 删除连接：级联删除该连接下的模型记录、Key 与指向这些模型的「上次使用模型」指针。
 * 已发出的请求不受影响（执行层使用解析时的快照）。
 */
export async function deleteConnection(id: string): Promise<void> {
  const [connections, models, lastModelId] = await Promise.all([
    loadConnections(),
    loadModels(),
    loadLastModelId()
  ]);
  if (!connections.some((connection) => connection.id === id)) {
    return;
  }

  const removedModels = models.filter((model) => model.connectionId === id);
  const remainingModels = models.filter((model) => model.connectionId !== id);
  const removedIds = new Set(removedModels.map((model) => model.id));

  // 先删依赖（模型 → Key → 指针），最后删连接，避免中途失败留下可见连接指向已删模型。
  await saveModels(remainingModels);
  await removeConnectionKey(id);
  if (lastModelId && removedIds.has(lastModelId)) {
    await saveLastModelId(null);
  }
  await saveConnections(connections.filter((connection) => connection.id !== id));
}

function validateRemoteModelId(value: string): string {
  const trimmed = requireTrimmed(value, '远端模型 ID 不能为空');
  if (trimmed.length > 128) {
    throw new Error('远端模型 ID 需为 1–128 个字符');
  }
  return trimmed;
}

function validateDisplayName(value: string): string {
  if (value.length < 1 || value.length > 60) {
    throw new Error('模型显示名需为 1–60 个字符');
  }
  return value;
}

function assertUniqueDisplayName(
  models: GenerationModelRecord[],
  displayName: string,
  excludeId?: string
): void {
  const normalized = displayName.toLowerCase();
  const duplicate = models.some(
    (model) =>
      model.id !== excludeId && model.displayName.trim().toLowerCase() === normalized
  );
  if (duplicate) {
    throw new Error('模型显示名已存在，请更换一个显示名');
  }
}

function validateMaxRefs(protocolMaxRefs: number, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > protocolMaxRefs) {
    throw new Error(`参考图上限需为 0–${protocolMaxRefs} 的整数`);
  }
  return value;
}

function validateMaxN(protocolMaxN: number, value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > protocolMaxN) {
    throw new Error(`单次数量上限需为 1–${protocolMaxN} 的整数`);
  }
  return value;
}

export async function createModel(input: {
  connectionId: string;
  protocolId: ProtocolId;
  remoteModelId: string;
  displayName?: string;
  supportsReferenceImage?: boolean;
  maxRefs?: number;
  maxN?: number;
}): Promise<GenerationModelRecord> {
  const connections = await loadConnections();
  if (!connections.some((connection) => connection.id === input.connectionId)) {
    throw new Error('所属服务商连接不存在');
  }

  if (!isProtocolId(input.protocolId)) {
    throw new Error('接口协议不存在');
  }
  const protocol = getProtocol(input.protocolId);
  if (!protocol) {
    throw new Error('接口协议不存在');
  }

  const models = await loadModels();
  const remoteModelId = validateRemoteModelId(input.remoteModelId);
  const requestedDisplayName =
    typeof input.displayName === 'string' ? input.displayName.trim() : '';
  const displayName = validateDisplayName(requestedDisplayName || remoteModelId);
  assertUniqueDisplayName(models, displayName);

  const supportsReferenceImage = input.supportsReferenceImage ?? true;
  const maxRefs = supportsReferenceImage
    ? validateMaxRefs(protocol.params.maxRefs, input.maxRefs ?? protocol.params.maxRefs)
    : 0;
  const maxN = validateMaxN(protocol.params.maxN, input.maxN ?? protocol.params.maxN);

  const record: GenerationModelRecord = {
    id: createId('model'),
    connectionId: input.connectionId,
    protocolId: input.protocolId,
    remoteModelId,
    displayName,
    supportsReferenceImage,
    maxRefs,
    maxN,
    createdAt: Date.now()
  };

  await saveModels([...models, record]);
  return record;
}

/**
 * 更新模型记录：connectionId / protocolId 创建后不可变。
 * 显示名留空时取（更新后的）远端型号；supportsReferenceImage=false 时 maxRefs 强制为 0。
 */
export async function updateModel(
  id: string,
  patch: {
    remoteModelId?: string;
    displayName?: string;
    supportsReferenceImage?: boolean;
    maxRefs?: number;
    maxN?: number;
  }
): Promise<void> {
  const models = await loadModels();
  const existing = models.find((model) => model.id === id);
  if (!existing) {
    throw new Error('模型记录不存在');
  }

  const protocol = getProtocol(existing.protocolId);
  if (!protocol) {
    throw new Error('接口协议不存在');
  }

  const remoteModelId =
    patch.remoteModelId !== undefined
      ? validateRemoteModelId(patch.remoteModelId)
      : existing.remoteModelId;

  const requestedDisplayName =
    patch.displayName !== undefined ? patch.displayName.trim() : existing.displayName;
  const displayName = validateDisplayName(requestedDisplayName || remoteModelId);
  assertUniqueDisplayName(models, displayName, id);

  const supportsReferenceImage =
    patch.supportsReferenceImage !== undefined
      ? patch.supportsReferenceImage
      : existing.supportsReferenceImage;

  let maxRefs: number;
  if (!supportsReferenceImage) {
    maxRefs = 0;
  } else if (patch.maxRefs !== undefined) {
    maxRefs = validateMaxRefs(protocol.params.maxRefs, patch.maxRefs);
  } else {
    maxRefs = existing.maxRefs;
  }

  const maxN =
    patch.maxN !== undefined
      ? validateMaxN(protocol.params.maxN, patch.maxN)
      : existing.maxN;

  await saveModels(
    models.map((model) =>
      model.id === id
        ? { ...model, remoteModelId, displayName, supportsReferenceImage, maxRefs, maxN }
        : model
    )
  );
}

/** 删除模型记录，并在它是指向目标时清理「上次使用模型」指针。 */
export async function deleteModel(id: string): Promise<void> {
  const [models, lastModelId] = await Promise.all([loadModels(), loadLastModelId()]);
  if (!models.some((model) => model.id === id)) {
    return;
  }
  await saveModels(models.filter((model) => model.id !== id));
  if (lastModelId === id) {
    await saveLastModelId(null);
  }
}

/** 记录上次使用的模型；id 必须指向存在的模型记录。 */
export async function setLastModel(id: string): Promise<void> {
  const models = await loadModels();
  if (!models.some((model) => model.id === id)) {
    throw new Error('模型记录不存在，无法设为上次使用');
  }
  await saveLastModelId(id);
}
