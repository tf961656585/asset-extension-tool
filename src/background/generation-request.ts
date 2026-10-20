import {
  buildGenerationRequestBody,
  resolveGenerationEndpoint,
  type GenerationParams,
  type GenerationReference,
  needsTranscode
} from '../shared/generation';
import { loadExtensionData } from '../shared/storage';
import { getGeneratedBlob } from '../shared/idb-asset-store';

/**
 * OpenAI Images 协议请求地址：Base URL（含版本路径）+ 协议相对端点。
 * 端点按本次请求的参考图列表裁定：为空 → /images/generations，非空 → /images/edits。
 */
export function buildOpenAIGenerationUrl(
  baseUrl: string,
  refs: GenerationReference[]
): string {
  return `${baseUrl}/images/${resolveGenerationEndpoint(refs)}`;
}

/**
 * 将 AVIF / WebP 等非 API 支持格式转码为 PNG（API 服务端基于 Pillow，默认不认 AVIF）。
 * 使用 createImageBitmap 解码 + OffscreenCanvas 绘制 + convertToBlob 编码（MV3 SW 标准模式，
 * Chromium 团队推荐）。转码失败抛错，由上层归入「参考图处理失败」。
 */
async function transcodeToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('OffscreenCanvas 2D 上下文不可用');
    }
    ctx.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    bitmap.close();
  }
}

/**
 * 按资产 id 查源资产是否为生成图（有 generatedFrom 即生成图，spec FR-21 第 2 条分流判据）。
 */
async function isGeneratedAsset(assetId: string): Promise<boolean> {
  const data = await loadExtensionData();
  const asset = data.assets.find((item) => item.id === assetId);
  return Boolean(asset?.generatedFrom);
}

/**
 * 解析参考图到 Blob：优先用已有的 blob；缺失时按来源分流回拉（spec FR-16 第 6 条 v3.7）。
 *
 * 调用方应先用 fromReferencePayloads 把消息载荷还原为内存态——local 来源的 blob 已从 base64 还原，
 * web/asset 来源无 blob，由本函数回拉字节：
 * - **web 来源**：fetch imageUrl 回拉（background 不受页面 CORS 约束；no-referrer 绕开防盗链）。
 * - **asset 来源**：若源资产为生成图（有 generatedFrom），imageUrl 为 IndexedDB 字节句柄（不可 fetch），
 *   按 assetId 从 IndexedDB 直取 Blob；否则按采集图处理、fetch imageUrl 回拉。
 *
 * 回拉/还原后统一做格式转码（needsTranscode 判定）：AVIF/WebP 等非 API 支持格式转为 PNG，
 * 确保交给 FormData 的字节一律为服务端可解码格式。转码后 blob.type 变为 image/png，
 * 后续 buildImageFilename 据此重算扩展名，保证 filename 与实际字节一致。
 */
export async function resolveReferenceBlobs(refs: GenerationReference[]): Promise<GenerationReference[]> {
  return Promise.all(
    refs.map(async (ref) => {
      let resolved = ref;
      if (!ref.blob) {
        if (ref.kind === 'asset' && ref.assetId && (await isGeneratedAsset(ref.assetId))) {
          // 生成图型资产库图：按 assetId 从 IndexedDB 直取 Blob，不 fetch 句柄（spec FR-21 / FR-16 v3.7）
          const blob = await getGeneratedBlob(ref.assetId);
          if (!blob) {
            throw new Error(`生成图字节缺失：${ref.assetId}`);
          }
          resolved = { ...ref, blob };
        } else if (ref.imageUrl) {
          // referrerPolicy: 'no-referrer' 绕开图片 CDN 的 Referer 防盗链
          // （background SW 对 chrome-extension:// 发起方默认 Referer 会触发 hdslb.com 等 CDN 的 403）。
          const res = await fetch(ref.imageUrl, { referrerPolicy: 'no-referrer' });
          if (!res.ok) {
            throw new Error(`参考图拉取失败：${ref.imageUrl}`);
          }
          resolved = { ...ref, blob: await res.blob() };
        } else {
          throw new Error('参考图缺少可访问的图片数据');
        }
      }
      if (needsTranscode(resolved)) {
        resolved = { ...resolved, blob: await transcodeToPng(resolved.blob as Blob) };
      }
      return resolved;
    })
  );
}

export interface OpenAIGenerationFetchInput {
  baseUrl: string;
  remoteModelId: string;
  apiKey: string;
  params: GenerationParams;
  refs: GenerationReference[];
}

/**
 * 构造 OpenAI Images 协议的 fetch init（spec §4.1）。
 * - 文生图：JSON body（model 为远端型号）
 * - 图生图：multipart body（image[] + 文本字段，model 为远端型号）
 * 鉴权头固定为 `Authorization: Bearer <key>`，Key 只进 header，不进 body。
 */
export function buildOpenAIGenerationFetchInit(
  input: OpenAIGenerationFetchInput
): RequestInit {
  const body = buildGenerationRequestBody(input.refs, {
    ...input.params,
    model: input.remoteModelId
  });
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${input.apiKey}`
  };

  if (body.endpoint === 'generations') {
    return {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body.json)
    };
  }

  const formData = new FormData();
  for (const part of body.parts) {
    if (part.value instanceof Blob) {
      // 第三参数 filename 必填：两参数 append 会让 part 的 Content-Disposition 为 filename="blob"（无扩展名），
      // 服务端无法识别图片格式，报 `Invalid image file or mode for image 1`（API spec §8 curl 样本每张图带扩展名）。
      formData.append(part.name, part.value, part.filename ?? 'image.png');
    } else {
      formData.append(part.name, part.value);
    }
  }

  return {
    method: 'POST',
    headers,
    body: formData
  };
}

/**
 * 执行生图请求。v3.2 明确「不主动预判远端返回时长、不设短超时」：
 * 直接 fetch 不带 signal，正常慢请求（实测数十秒至数分钟）必须等待至完成；
 * 请求终止仅由被动断连（网络断开 / SW 回收 / 侧边栏关闭）触发，不主动 abort。
 */
export async function executeGenerationRequest(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  return await response.json();
}
