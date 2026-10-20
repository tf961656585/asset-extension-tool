import {
  blobToBase64,
  type GenerationParams,
  type GenerationReference
} from '../shared/generation';
import { parseRatioSize, validateSizeForProtocol } from '../shared/protocols';

/**
 * Gemini Image 协议请求地址：Base URL（含版本路径）+ `/models/{remoteModelId}:generateContent`。
 * remoteModelId 进入 URL 路径前必须做百分号编码；文生图与图生图共用同一端点（不分流）。
 */
export function buildGoogleGenerationUrl(baseUrl: string, remoteModelId: string): string {
  return `${baseUrl}/models/${encodeURIComponent(remoteModelId)}:generateContent`;
}

/**
 * 将参考图 Blob 列表转为 Gemini contents.parts 所需的 inlineData 块。
 * Gemini inlineData 格式：{ mimeType, data }（data 为不带 `data:...;base64,` 前缀的纯 base64）。
 *
 * 字段命名为 Google REST 原生 camelCase（`inlineData`/`mimeType`），与响应解析端一致；
 * 非 Python SDK 风格的 snake_case（`inline_data`/`mime_type`）。
 *
 * 参考图经上游 resolveReferenceBlobs 处理后均带 blob（AVIF/WebP 已转码 PNG），
 * 此处不再做格式转码，仅按 blob.type 读取 MIME（兜底 image/png）。
 */
async function refsToInlineDataParts(
  refs: GenerationReference[]
): Promise<Array<{ inlineData: { mimeType: string; data: string } }>> {
  const parts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
  for (const ref of refs) {
    const blob = ref.blob;
    if (!blob) {
      throw new Error('Gemini 参考图缺少 blob 字节');
    }
    const mimeType = blob.type && blob.type.length > 0 ? blob.type : 'image/png';
    const data = await blobToBase64(blob);
    parts.push({ inlineData: { mimeType, data } });
  }
  return parts;
}

export interface GoogleGenerationFetchInput {
  baseUrl: string;
  remoteModelId: string;
  apiKey: string;
  params: GenerationParams;
  refs: GenerationReference[];
}

/**
 * 构建 Gemini generateContent 请求（spec §4.1）。
 *
 * 请求体结构：
 * - contents[0].role = 'user'
 * - contents[0].parts：[{ text: prompt }, ...参考图 inlineData]（prompt 为空时跳过 text part）
 * - generationConfig.responseModalities = ['TEXT', 'IMAGE']
 * - generationConfig.imageConfig = { aspectRatio, imageSize }（从 params.size 的 `ratio@size` 格式拆出）
 *
 * 文生图（refs 空）与图生图（refs 非空）差异仅在 contents 是否含 inlineData parts。
 * 鉴权头固定为 `x-goog-api-key`（不再发 Authorization: Bearer）。
 */
export async function buildGoogleGenerationFetchInit(
  input: GoogleGenerationFetchInput
): Promise<RequestInit> {
  const parsedSize = parseRatioSize(input.params.size);
  if (!parsedSize || !validateSizeForProtocol('gemini-image-v1', input.params.size)) {
    // resolveInvocation 已按协议校验；这里不静默兜底，避免发出与参数不一致的请求。
    throw new Error('Gemini 尺寸格式不合法，应为 <ratio>@<size>');
  }

  const trimmedPrompt = (input.params.prompt ?? '').trim();

  const parts: Array<Record<string, unknown>> = [];
  if (trimmedPrompt.length > 0) {
    parts.push({ text: trimmedPrompt });
  }
  const imageParts = await refsToInlineDataParts(input.refs);
  parts.push(...imageParts);

  const body = {
    contents: [
      {
        role: 'user',
        parts
      }
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: parsedSize.aspectRatio,
        imageSize: parsedSize.imageSize
      }
    }
  };

  return {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-goog-api-key': input.apiKey
    },
    body: JSON.stringify(body)
  };
}
