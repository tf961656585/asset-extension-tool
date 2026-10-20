export const STORAGE_KEY = 'asset_manager_v1';
export const DATA_VERSION = 1;
export const DEFAULT_FOLDER_ID = 'unassigned';
export const MANAGED_ROOT_DIR_NAME = 'WYJHExtension';

/**
 * 生图模型供应商（v3.8）：渲染层徽标与血缘追溯。
 * 与 src/shared/protocols.ts 的 LegacyProvider 保持字面量一致；此处单独声明以避免 model.ts ↔ protocols.ts 循环依赖。
 */
export type GenerationProvider = 'openai-image' | 'google-image';

export interface FolderRecord {
  id: string;
  name: string;
  createdAt: string;
}

export interface ExtensionSettings {
  saveBaseDir: string;
}

export type GenerationMode = 'text-to-image' | 'image-to-image';

/** 生成图血缘中的单张参考图引用（剥离 blob 后用于落盘记录，不承载大二进制）。 */
export type SourceRef =
  | { kind: 'asset'; assetId: string }
  | { kind: 'web'; imageUrl: string }
  | { kind: 'local'; filename: string };

/** 生成图血缘，标识该资产由 AI 生成（含模式 / 源参考图 / 参数）。 */
export interface GeneratedFrom {
  mode: GenerationMode;
  sourceRefs: SourceRef[];
  prompt: string;
  /** 生图时使用的远端型号（v3.9：模型记录的 remoteModelId，即请求体或路径中的 wire id）。 */
  model: string;
  /** 生成时模型显示名的快照（v3.9 新增可选）；旧资产可缺失。 */
  modelName?: string;
  /**
   * 尺寸（v3.8 多模型双语义）：
   * - openai-image：`<W>x<H>`、`auto`、自定义 `WxH`
   * - google-image：`<aspectRatio>@<imageSize>`（如 `1:1@1K`）
   */
  size: string;
  /** 用户请求的画质值（low/medium/high/auto）；google 模型为空串。记用户意图，实际生效以 API 响应为准（spec FR-18 v3.4）。 */
  quality: string;
  n: number;
  generatedAt: string;
  /**
   * 生图协议族（v3.8 新增可选）：openai-image / google-image。
   * 缺失时按 'openai-image' 兜底（存量 gpt-image-2 资产无此字段）。
   */
  provider?: GenerationProvider;
  /** 生成时所选服务商连接名称的快照（v3.9 新增可选）；旧资产可缺失。 */
  connectionName?: string;
  /** 生成时连接的主机名快照（不含 path / query / Key，v3.9 新增可选）；旧资产可缺失。 */
  baseUrlHost?: string;
}

export interface AssetRecord {
  id: string;
  imageUrl: string;
  sourcePageUrl: string;
  sourceDomain: string;
  savedAt: string;
  downloadId: number;
  filename: string;
  folderId: string | null;
  tags: string[];
  /** 仅生成图携带；存量采集资产无此字段，读取链路不受影响。 */
  generatedFrom?: GeneratedFrom;
}

export interface ExtensionData {
  version: number;
  settings: ExtensionSettings;
  folders: FolderRecord[];
  assets: AssetRecord[];
}

export interface AssetQuery {
  siteKeyword?: string;
  folderId?: string;
  tags?: string[];
}

export interface CreateAssetInput {
  imageUrl: string;
  sourcePageUrl: string;
  sourceDomain?: string;
  downloadId: number;
  filename: string;
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function createDefaultData(): ExtensionData {
  return {
    version: DATA_VERSION,
    settings: {
      saveBaseDir: ''
    },
    folders: [
      {
        id: DEFAULT_FOLDER_ID,
        name: '未分类',
        createdAt: nowISO()
      }
    ],
    assets: []
  };
}

export function normalizeDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown-site';
  }
}

function sanitizePathPart(part: string): string {
  const sanitized = part.replace(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized || 'unknown';
}

export function normalizeRelativeDir(value: string): string {
  return value
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => sanitizePathPart(part))
    .join('/');
}

export function buildManagedRootDir(saveBaseDir: string): string {
  const normalizedBaseDir = normalizeRelativeDir(saveBaseDir);
  if (!normalizedBaseDir) {
    return MANAGED_ROOT_DIR_NAME;
  }

  const parts = normalizedBaseDir.split('/');
  const lastPart = parts[parts.length - 1];
  if (lastPart.toLowerCase() === MANAGED_ROOT_DIR_NAME.toLowerCase()) {
    return normalizedBaseDir;
  }

  return `${normalizedBaseDir}/${MANAGED_ROOT_DIR_NAME}`;
}

function inferFileExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    if (!match) {
      return 'png';
    }

    return match[1].toLowerCase();
  } catch {
    return 'png';
  }
}

export function buildAssetFilename(input: {
  imageUrl: string;
  sourceDomain: string;
  saveBaseDir: string;
  now?: Date;
}): string {
  const extension = inferFileExtension(input.imageUrl);
  const timestamp = (input.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const managedRoot = buildManagedRootDir(input.saveBaseDir);
  return `${managedRoot}/${sanitizePathPart(input.sourceDomain)}/${timestamp}.${extension}`;
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

export function parseTagInput(value: string): string[] {
  return value
    .split(',')
    .map((part) => normalizeTag(part))
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index);
}

export function sanitizeTags(tags: string[]): string[] {
  return tags
    .map((tag) => normalizeTag(tag))
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index);
}

export function createAssetRecord(input: CreateAssetInput): AssetRecord {
  return {
    id: createId('asset'),
    imageUrl: input.imageUrl,
    sourcePageUrl: input.sourcePageUrl,
    sourceDomain: input.sourceDomain ?? normalizeDomain(input.sourcePageUrl),
    savedAt: nowISO(),
    downloadId: input.downloadId,
    filename: input.filename,
    folderId: DEFAULT_FOLDER_ID,
    tags: []
  };
}

export interface CreateGeneratedAssetInput {
  imageUrl: string;
  sourcePageUrl: string;
  sourceDomain?: string;
  downloadId: number;
  filename: string;
  generatedFrom: GeneratedFrom;
}

/**
 * 生图资产的专用创建函数：带血缘落库。
 * 保持与 createAssetRecord 一致的 downloadId 入参（由 background 落盘后回填），不破坏去重契约。
 * 生图无真实来源网站，sourceDomain 默认伪域名 'ai-generated'（spec 设计取舍）。
 */
export function createGeneratedAssetRecord(input: CreateGeneratedAssetInput): AssetRecord {
  return {
    id: createId('asset'),
    imageUrl: input.imageUrl,
    sourcePageUrl: input.sourcePageUrl,
    sourceDomain: input.sourceDomain ?? 'ai-generated',
    savedAt: nowISO(),
    downloadId: input.downloadId,
    filename: input.filename,
    folderId: DEFAULT_FOLDER_ID,
    tags: [],
    generatedFrom: input.generatedFrom
  };
}

export function upsertAsset(data: ExtensionData, asset: AssetRecord): ExtensionData {
  const existed = data.assets.some((item) => item.downloadId === asset.downloadId);
  const assets = existed
    ? data.assets.map((item) => (item.downloadId === asset.downloadId ? asset : item))
    : [asset, ...data.assets];

  return {
    ...data,
    assets: assets.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  };
}

export function addFolder(data: ExtensionData, folderName: string): { data: ExtensionData; folder: FolderRecord } {
  const trimmedName = folderName.trim();
  if (!trimmedName) {
    return { data, folder: data.folders[0] };
  }

  const existed = data.folders.find((folder) => folder.name.toLowerCase() === trimmedName.toLowerCase());
  if (existed) {
    return { data, folder: existed };
  }

  const folder: FolderRecord = {
    id: createId('folder'),
    name: trimmedName,
    createdAt: nowISO()
  };

  return {
    folder,
    data: {
      ...data,
      folders: [...data.folders, folder]
    }
  };
}

export function updateAssetTags(data: ExtensionData, assetId: string, tags: string[]): ExtensionData {
  const normalizedTags = sanitizeTags(tags);

  return {
    ...data,
    assets: data.assets.map((asset) =>
      asset.id === assetId
        ? {
            ...asset,
            tags: normalizedTags
          }
        : asset
    )
  };
}

export function updateAssetFolder(data: ExtensionData, assetId: string, folderId: string | null): ExtensionData {
  return {
    ...data,
    assets: data.assets.map((asset) =>
      asset.id === assetId
        ? {
            ...asset,
            folderId
          }
        : asset
    )
  };
}

function includesKeyword(text: string, keyword: string): boolean {
  return text.toLowerCase().includes(keyword.toLowerCase());
}

export function filterAssets(data: ExtensionData, query: AssetQuery): AssetRecord[] {
  const siteKeyword = query.siteKeyword?.trim();
  const folderId = query.folderId;
  const tags = sanitizeTags(query.tags ?? []);

  return data.assets.filter((asset) => {
    const matchSite =
      !siteKeyword ||
      includesKeyword(asset.sourceDomain, siteKeyword) ||
      includesKeyword(asset.sourcePageUrl, siteKeyword);
    const matchFolder = !folderId || folderId === 'all' || asset.folderId === folderId;
    const matchTags = tags.every((tag) => asset.tags.includes(tag));

    return matchSite && matchFolder && matchTags;
  });
}
