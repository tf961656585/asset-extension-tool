import {
  createGeneratedAssetRecord,
  type AssetRecord,
  type GeneratedFrom,
  type GenerationMode,
  upsertAsset
} from '../shared/model';
import {
  base64ToBlob,
  toSourceRefs,
  type GenerationParams,
  type GenerationReference
} from '../shared/generation';
import { mutateExtensionData } from '../shared/storage';
import { putGeneratedBlob } from '../shared/idb-asset-store';
import type { LegacyProvider } from '../shared/protocols';
import type { ParsedGenerationResponse } from './generation-response';

/**
 * 血缘快照：写入时固化的模型/连接信息，只用于追溯，不作为执行依据。
 * 模型或连接删除后，历史资产仍可读取这些字段。
 */
export interface GenerationLineageSnapshot {
  /** 远端型号（wire id，如 gpt-image-2 / gemini-3.1-flash-image）。 */
  model: string;
  /** 模型显示名快照。 */
  modelName: string;
  /** 协议族（openai-image / google-image）。 */
  provider: LegacyProvider;
  /** 服务商连接名称快照。 */
  connectionName: string;
  /** 连接主机名快照（不含 path / query / Key）。 */
  baseUrlHost: string;
}

function mimeFromFormat(format?: string): string {
  return format ? `image/${format}` : 'image/png';
}

function extensionFromFormat(format?: string): string {
  if (!format) {
    return 'png';
  }
  return format === 'jpeg' ? 'jpg' : format;
}

/**
 * 将生图结果落盘并带血缘写资产库（spec FR-21 第 4 条三处原子）：
 *
 * base64 → Blob → 写入 IndexedDB（字节唯一承载层）+ 磁盘落盘（data: URL 仅供 chrome.downloads，
 * blob: 不可靠）→ 获真实 downloadId → createGeneratedAssetRecord（imageUrl 为字节句柄=资产 id，
 * 不再是 base64 data URL）→ mutateExtensionData（资产库元数据唯一写入方）。
 *
 * 「磁盘 / IndexedDB / 资产库」三处写入按序 await，任一失败则 persist 整体抛错；
 * 下载落盘是固有的非原子点（先于其他写入执行），与改造前一致，属可接受取舍。
 */
export async function persistGenerationResult(
  result: ParsedGenerationResponse,
  refs: GenerationReference[],
  params: GenerationParams,
  lineage: GenerationLineageSnapshot
): Promise<AssetRecord[]> {
  const sourceRefs = toSourceRefs(refs);
  const mode: GenerationMode = refs.length === 0 ? 'text-to-image' : 'image-to-image';
  // 血缘快照：model 存远端型号；modelName / connectionName / baseUrlHost 为追溯用快照。
  const generatedFrom: GeneratedFrom = {
    mode,
    sourceRefs,
    prompt: params.prompt,
    model: lineage.model,
    modelName: lineage.modelName,
    provider: lineage.provider,
    connectionName: lineage.connectionName,
    baseUrlHost: lineage.baseUrlHost,
    size: params.size,
    quality: params.quality ?? '',
    n: params.n,
    generatedAt: new Date().toISOString()
  };

  const created: AssetRecord[] = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const extension = extensionFromFormat(result.outputFormat);
  const filename = `WYJHExtension/ai-generated/${timestamp}.${extension}`;

  for (const image of result.images) {
    const mime = mimeFromFormat(result.outputFormat);
    // data: URL 仅用于触发 chrome.downloads 落盘（blob: 不可靠），不入库、不进 storage
    const downloadUrl = `data:${mime};base64,${image.b64}`;
    // 字节 Blob 存入 IndexedDB（资产 id 为键），不写入 chrome.storage.local
    const blob = base64ToBlob(image.b64, mime);

    const downloadId = await chrome.downloads.download({
      url: downloadUrl,
      filename,
      conflictAction: 'uniquify',
      saveAs: false
    });

    const asset = createGeneratedAssetRecord({
      imageUrl: '', // 占位，下方按 id 回填为字节句柄
      // 生成图没有真实来源页：留空，由 createGeneratedAssetRecord 使用伪域名 ai-generated 供卡片展示。
      sourcePageUrl: '',
      downloadId,
      filename,
      generatedFrom
    });
    // imageUrl = 资产 id（IndexedDB 字节句柄，spec FR-21 第 2 条）
    asset.imageUrl = asset.id;

    await putGeneratedBlob(asset.id, blob);
    await mutateExtensionData((data) => upsertAsset(data, asset));
    created.push(asset);
  }

  return created;
}
