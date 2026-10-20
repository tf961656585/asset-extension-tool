/**
 * 生图执行解析（v3.9，spec model-access-architecture-v1 §7）。
 *
 * 任务只携带 modelRecordId；本模块把模型记录解析成执行所需的记录、连接、协议与 Key，
 * 并按固定顺序校验，失败抛出带稳定原因码的 InvocationError。不构造 HTTP 请求。
 */

import {
  findConnection,
  findModel,
  loadGenerationConfig,
  normalizeBaseUrl,
  type GenerationModelRecord,
  type ProviderConnection
} from '../shared/generation-config';
import { getProtocol, validateSizeForProtocol, type ProtocolDescriptor } from '../shared/protocols';
import type { GenerationFailureReason } from '../shared/messages';
import { getConnectionKey } from './credentials';

/** 执行解析失败原因码（定义于 shared/messages，供反馈载荷与解析层共用同一字面量集合）。 */
export type InvocationErrorCode = GenerationFailureReason;

export class InvocationError extends Error {
  readonly code: InvocationErrorCode;
  readonly userMessage: string;

  constructor(code: InvocationErrorCode, userMessage: string) {
    super(userMessage);
    this.name = 'InvocationError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

export interface ResolveInvocationInput {
  modelRecordId: string;
  prompt: string;
  size: string;
  quality: string;
  n: number;
  referenceCount: number;
}

export interface ResolvedInvocation {
  record: GenerationModelRecord;
  connection: ProviderConnection;
  protocol: ProtocolDescriptor;
  apiKey: string;
}

function invalidParams(userMessage: string): InvocationError {
  return new InvocationError('invalid_params', userMessage);
}

/**
 * 参数校验（FR-17 第 7 条 / spec §7.3）。
 * 模型能力不得超过协议上限，执行层按两者交集校验，避免脏记录绕过协议约束。
 */
function validateParams(
  input: ResolveInvocationInput,
  record: GenerationModelRecord,
  protocol: ProtocolDescriptor
): void {
  if (input.prompt.trim().length === 0) {
    throw invalidParams('提示词不能为空');
  }

  if (!validateSizeForProtocol(protocol.id, input.size)) {
    throw invalidParams('尺寸不符合当前接口协议');
  }

  if (protocol.params.quality.length > 0) {
    const matched = protocol.params.quality.some((option) => option.value === input.quality);
    if (!matched) {
      throw invalidParams('画质不符合当前接口协议');
    }
  } else if (input.quality !== '') {
    throw invalidParams('当前接口协议不支持画质参数');
  }

  const maxN = (() => {
    const modelMaxN =
      Number.isInteger(record.maxN) && record.maxN >= 1 ? record.maxN : 0;
    return Math.min(modelMaxN, protocol.params.maxN);
  })();
  if (maxN < 1) {
    throw invalidParams('模型的数量上限配置无效，请到设置页检查。');
  }
  if (!Number.isInteger(input.n) || input.n < 1 || input.n > maxN) {
    throw invalidParams(`生成数量需为 1–${maxN} 的整数`);
  }

  const modelMaxRefs =
    Number.isInteger(record.maxRefs) && record.maxRefs >= 0 ? record.maxRefs : 0;
  const maxRefs = record.supportsReferenceImage
    ? Math.max(0, Math.min(modelMaxRefs, protocol.params.maxRefs))
    : 0;
  if (
    !Number.isInteger(input.referenceCount) ||
    input.referenceCount < 0 ||
    input.referenceCount > maxRefs
  ) {
    throw invalidParams(
      maxRefs === 0
        ? '当前模型不支持参考图'
        : `参考图数量需为 0–${maxRefs} 张`
    );
  }
}

/**
 * 按 spec §7.2 顺序解析一次生图调用：
 * 模型记录 → 连接 → Key → 协议 → Base URL → 参数。
 * 任一步失败立即抛出 InvocationError，不回落默认模型/连接/协议。
 */
export async function resolveInvocation(
  input: ResolveInvocationInput
): Promise<ResolvedInvocation> {
  const config = await loadGenerationConfig();

  const record = findModel(config, input.modelRecordId);
  if (!record) {
    throw new InvocationError('model_not_found', '找不到所选模型，请到设置页重新选择。');
  }

  const connection = findConnection(config, record.connectionId);
  if (!connection) {
    throw new InvocationError(
      'connection_not_found',
      '模型所属服务商连接不存在，请到设置页检查。'
    );
  }

  const apiKey = (await getConnectionKey(connection.id)).trim();
  if (!apiKey) {
    throw new InvocationError(
      'key_missing',
      `服务商「${connection.name}」未配置 API Key，请到设置页填写。`
    );
  }

  const protocol = getProtocol(record.protocolId);
  if (!protocol) {
    throw new InvocationError(
      'protocol_unsupported',
      '模型使用的接口协议不受支持，请到设置页重新添加模型。'
    );
  }

  let normalizedBaseUrl: string;
  try {
    normalizedBaseUrl = normalizeBaseUrl(connection.baseUrl);
  } catch {
    throw new InvocationError(
      'invalid_base_url',
      `服务商「${connection.name}」的 Base URL 不合法，请到设置页检查。`
    );
  }

  validateParams(input, record, protocol);

  // 返回规范化地址（去尾部 `/`），保证请求 URL 拼接不产生双斜杠；元数据其余字段原样透传。
  return {
    record,
    connection: { ...connection, baseUrl: normalizedBaseUrl },
    protocol,
    apiKey
  };
}
