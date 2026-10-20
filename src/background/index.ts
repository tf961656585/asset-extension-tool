import {
  createAssetRecord,
  upsertAsset,
  type CreateAssetInput
} from '../shared/model';
import {
  MESSAGE_TYPES,
  isGenerationSubmitPayload,
  type GenerationCancelTaskPayload,
  type GenerationCreateTaskPayload,
  type GenerationSubmitPayload,
  type RuntimeMessage,
  type SaveImagePayload,
  type SaveImageResponse
} from '../shared/messages';
import { resolveSaveRequest } from '../shared/save';
import { loadExtensionData, mutateExtensionData } from '../shared/storage';
import {
  buildOpenAIGenerationFetchInit,
  buildOpenAIGenerationUrl,
  executeGenerationRequest,
  resolveReferenceBlobs
} from './generation-request';
import {
  buildGoogleGenerationFetchInit,
  buildGoogleGenerationUrl
} from './generation-request-google';
import {
  extractErrorMessage,
  isErrorResponse,
  parseGenerationResponse
} from './generation-response';
import { persistGenerationResult } from './generation-persist';
import { createTaskId, fromReferencePayloads } from '../shared/generation';
import { cleanupLegacyGenerationConfig } from './credentials';
import { InvocationError, resolveInvocation } from './resolve-invocation';

/** 启动即清理旧版生图配置键（幂等；不迁移，spec §8.2）。 */
void cleanupLegacyGenerationConfig().catch(() => undefined);

const CONTEXT_MENU_SAVE_IMAGE_ID = 'wyjh-save-image-as-asset';
const CONTEXT_MENU_GENERATE_ID = 'wyjh-generate-from-image';
const SIDE_PANEL_PORT_NAME = 'sidepanel';

/** sidepanel 长连接 port：存活期间保持 SW 不被回收（生图长任务 keepalive）。 */
let sidePanelPort: chrome.runtime.Port | null = null;

/**
 * 在飞任务句柄表：仅用于控制在飞请求（取消回调 + 僵尸兜底计时），不持有任何任务业务状态。
 * 与「background 无状态执行方」一致——background 仅按 taskId 路由 feedback，状态归 sidepanel 持有。
 */
interface InflightHandle {
  onAbort?: () => void;
  zombieTimer?: ReturnType<typeof setTimeout>;
}
const inflightHandles = new Map<string, InflightHandle>();

/** 侧边栏未连接时收到的 CREATE_TASK 缓冲：连接建立后批量 flush 转发，避免新任务静默丢失。 */
const pendingCreateTasks: GenerationCreateTaskPayload[] = [];

function sendToSidePanel(message: RuntimeMessage): void {
  if (sidePanelPort) {
    sidePanelPort.postMessage(message);
  }
}

function flushPendingCreateTasks(): void {
  if (!sidePanelPort) {
    return;
  }
  while (pendingCreateTasks.length > 0) {
    const payload = pendingCreateTasks.shift()!;
    sendToSidePanel({ type: MESSAGE_TYPES.GENERATION_CREATE_TASK, payload });
  }
}

async function openSidePanel(): Promise<void> {
  try {
    await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  } catch {
    // 手势上下文可能不传递，忽略；由用户手动打开 sidepanel。
  }
}

async function saveImageToDisk(input: CreateAssetInput): Promise<SaveImageResponse> {
  const downloadId = await chrome.downloads.download({
    url: input.imageUrl,
    filename: input.filename,
    conflictAction: 'uniquify',
    saveAs: false
  });

  if (downloadId === undefined) {
    return {
      ok: false,
      error: '下载失败，请检查图片链接是否可访问。'
    };
  }

  const [downloadItem] = await chrome.downloads.search({ id: downloadId });
  const asset = createAssetRecord({
    ...input,
    downloadId,
    filename: downloadItem?.filename ?? input.filename
  });

  await mutateExtensionData((data) => upsertAsset(data, asset));

  return {
    ok: true,
    asset
  };
}

async function saveImageFromPayload(payload: SaveImagePayload): Promise<SaveImageResponse> {
  const data = await loadExtensionData();
  const request = resolveSaveRequest(payload, data.settings.saveBaseDir);

  return saveImageToDisk({
    imageUrl: request.imageUrl,
    sourcePageUrl: request.sourcePageUrl,
    sourceDomain: request.sourceDomain,
    filename: request.filename,
    downloadId: -1
  });
}

async function notifySaveResult(tabId: number | undefined, response: SaveImageResponse): Promise<void> {
  if (!tabId) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.SAVE_FEEDBACK,
      payload: {
        ok: response.ok,
        message: response.ok ? '图片已保存到资产库。' : `保存失败：${response.error}`
      }
    });
  } catch {
    // 部分页面（如 chrome://）无法投递内容脚本消息，忽略反馈失败即可。
  }
}

/** 测试用：注入 sidepanel port 以捕获 feedback（生产路径由 onConnect 设置，测试可观察路由结果）。 */
export function setSidePanelPort(port: chrome.runtime.Port | null): void {
  sidePanelPort = port;
}

export async function handleGenerationSubmit(payload: GenerationSubmitPayload): Promise<void> {
  const { taskId } = payload;

  try {
    // 执行解析：模型记录 → 连接 → Key → 协议 → Base URL → 参数（spec §7.2）。
    // 失败直接反馈稳定原因的可读文案，不回退默认模型 / 连接 / 协议。
    const invocation = await resolveInvocation({
      modelRecordId: payload.modelRecordId,
      prompt: payload.prompt,
      size: payload.size,
      quality: payload.quality,
      n: payload.n,
      referenceCount: payload.references.length
    });
    const { record, connection, protocol, apiKey } = invocation;

    sendToSidePanel({
      type: MESSAGE_TYPES.GENERATION_FEEDBACK,
      payload: { taskId, level: 'info', message: '生图任务已提交' }
    });

    // 载荷态→内存态：local 来源从 base64 还原 Blob，web/asset 来源保留 URL 待回拉（spec FR-16 第 6 条 v3.5）。
    const refs = await resolveReferenceBlobs(fromReferencePayloads(payload.references));

    // 按协议选择请求构建器：请求地址 = 连接 Base URL（含版本路径）+ 协议相对端点。
    // - gemini-image-v1：固定 /models/{remoteModelId}:generateContent，JSON body。
    // - openai-images-v1：参考图为空→/images/generations JSON；非空→/images/edits multipart。
    let fetchUrl: string;
    let init: RequestInit;
    if (protocol.id === 'gemini-image-v1') {
      fetchUrl = buildGoogleGenerationUrl(connection.baseUrl, record.remoteModelId);
      init = await buildGoogleGenerationFetchInit({
        baseUrl: connection.baseUrl,
        remoteModelId: record.remoteModelId,
        apiKey,
        params: payload,
        refs
      });
    } else if (protocol.id === 'openai-images-v1') {
      fetchUrl = buildOpenAIGenerationUrl(connection.baseUrl, refs);
      init = buildOpenAIGenerationFetchInit({
        baseUrl: connection.baseUrl,
        remoteModelId: record.remoteModelId,
        apiKey,
        params: payload,
        refs
      });
    } else {
      // 协议描述符新增但执行器未接入时必须显式失败，不得回落到 OpenAI 执行分支。
      throw new InvocationError(
        'protocol_unsupported',
        '该模型的接口协议暂无可用的请求执行器，请到设置页检查。'
      );
    }

    // v3.2：不主动超前断言远端时长，不设短超时。仅登记「在飞句柄」供用户取消，
    // 以及每任务 10 分钟僵尸兜底（仅清理半开僵死连接、不预测正常慢请求）。
    let aborted = false;
    const handle: InflightHandle = {
      onAbort: () => {
        aborted = true;
      }
    };
    inflightHandles.set(taskId, handle);
    handle.zombieTimer = setTimeout(() => {
      // 僵尸兜底触发后标记 aborted，确保后续迟到的成功响应被丢弃（仅保留可重试 error）。
      aborted = true;
      inflightHandles.delete(taskId);
      sendToSidePanel({
        type: MESSAGE_TYPES.GENERATION_FEEDBACK,
        payload: {
          taskId,
          level: 'error',
          message: '生图连接超时（僵尸兜底），可重试。'
        }
      });
    }, 10 * 60 * 1000);

    const json = await executeGenerationRequest(fetchUrl, init);

    const timer = handle.zombieTimer;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    inflightHandles.delete(taskId);

    if (aborted) {
      // 用户取消 / 被动断连已触发，不再投递结果反馈。
      return;
    }

    if (isErrorResponse(json)) {
      sendToSidePanel({
        type: MESSAGE_TYPES.GENERATION_FEEDBACK,
        payload: { taskId, level: 'error', message: extractErrorMessage(json) }
      });
      return;
    }

    // 响应解析按协议分流：openai-images-v1（data[].b64_json）/ gemini-image-v1（candidates[].parts.inlineData）。
    const parsed = parseGenerationResponse(json, protocol.id);
    if (parsed.images.length === 0) {
      sendToSidePanel({
        type: MESSAGE_TYPES.GENERATION_FEEDBACK,
        payload: { taskId, level: 'error', message: '生图未返回图片' }
      });
      return;
    }

    const created = await persistGenerationResult(parsed, refs, payload, {
      model: record.remoteModelId,
      modelName: record.displayName,
      provider: protocol.provider,
      connectionName: connection.name,
      baseUrlHost: new URL(connection.baseUrl).hostname
    });
    sendToSidePanel({
      type: MESSAGE_TYPES.GENERATION_FEEDBACK,
      payload: {
        taskId,
        level: 'success',
        message: `生成完成，${created.length} 张已入库`,
        count: created.length
      }
    });
  } catch (error) {
    const timer = inflightHandles.get(taskId)?.zombieTimer;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    inflightHandles.delete(taskId);

    // 解析失败返回稳定原因码 + 可读文案；被动断连（网络断开 / fetch 抛错 / 响应非 JSON）统一归为可重试文案。
    // 错误信息不含 API Key；非 InvocationError 不向上暴露原始解析错误（用户看不懂 "Unexpected token '<'"）。
    const message =
      error instanceof InvocationError
        ? error.userMessage
        : '生图失败，请检查服务地址、Key 与网络后重试。';
    sendToSidePanel({
      type: MESSAGE_TYPES.GENERATION_FEEDBACK,
      payload: {
        taskId,
        level: 'error',
        message,
        ...(error instanceof InvocationError ? { reason: error.code } : {})
      }
    });
  }
}

/** 收到 CREATE_TASK：打开侧边栏（若未连则缓冲），并将其转发给 sidepanel 由 UI 建任务。background 不持有任务状态。 */
function handleCreateTask(payload: GenerationCreateTaskPayload): void {
  void openSidePanel();
  if (sidePanelPort) {
    sendToSidePanel({ type: MESSAGE_TYPES.GENERATION_CREATE_TASK, payload });
  } else {
    pendingCreateTasks.push(payload);
  }
}

/** 收到 CANCEL_TASK：触发该任务在飞请求的 onAbort（若 in-flight）并清理句柄。 */
function handleCancelTask(payload: GenerationCancelTaskPayload): void {
  const handle = inflightHandles.get(payload.taskId);
  if (handle) {
    if (handle.zombieTimer !== undefined) {
      clearTimeout(handle.zombieTimer);
    }
    handle.onAbort?.();
    inflightHandles.delete(payload.taskId);
  }
}

async function ensureImageContextMenu(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: CONTEXT_MENU_SAVE_IMAGE_ID,
    title: '保存为资产',
    contexts: ['image']
  });
  chrome.contextMenus.create({
    id: CONTEXT_MENU_GENERATE_ID,
    title: '用这张图 AI 生成',
    contexts: ['image']
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void mutateExtensionData((data) => data)
    .then(() => ensureImageContextMenu())
    .catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  void ensureImageContextMenu().catch(() => undefined);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SIDE_PANEL_PORT_NAME) {
    return;
  }
  sidePanelPort = port;
  flushPendingCreateTasks();
  port.onDisconnect.addListener(() => {
    if (sidePanelPort === port) {
      sidePanelPort = null;
    }
    // 被动断连：中止所有在飞请求并清理僵尸计时，避免悬挂僵尸连接占用。
    // sidepanel 自身在 port 断开时会将 generating 任务标回 collecting（可重试态）。
    for (const handle of inflightHandles.values()) {
      if (handle.zombieTimer !== undefined) {
        clearTimeout(handle.zombieTimer);
      }
      handle.onAbort?.();
    }
    inflightHandles.clear();
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info.srcUrl) {
    return;
  }
  const sourcePageUrl = info.pageUrl ?? tab?.url ?? '';

  if (info.menuItemId === CONTEXT_MENU_SAVE_IMAGE_ID) {
    const payload: SaveImagePayload = {
      imageUrl: info.srcUrl,
      sourcePageUrl
    };

    void saveImageFromPayload(payload)
      .catch(
        (error: unknown): SaveImageResponse => ({
          ok: false,
          error: error instanceof Error ? error.message : '未知错误'
        })
      )
      .then((response) => notifySaveResult(tab?.id, response));
    return;
  }

  if (info.menuItemId === CONTEXT_MENU_GENERATE_ID) {
    // reference-first 入口：每次点击创建新任务（首张参考图 + collecting）。
    handleCreateTask({
      taskId: createTaskId(),
      mode: 'reference-first',
      references: [{ kind: 'web', imageUrl: info.srcUrl }]
    });
  }
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === MESSAGE_TYPES.SAVE_IMAGE) {
    void saveImageFromPayload(message.payload)
      .then((response) => sendResponse(response))
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : '未知错误'
        } satisfies SaveImageResponse);
      });

    return true;
  }

  if (message.type === MESSAGE_TYPES.GENERATION_SUBMIT) {
    // 单向 fire-and-forget：结果经 sidePanelPort 回传，不经 sendResponse。
    // 不得 return true，否则调用方 sendMessage 会一直等待 sendResponse，
    // 待 SW 空闲回收后通道关闭而被 reject（表现为「提交生图请求失败」误报）。
    // 异步 fetch 会自行保持 SW 存活至生图完成。
    if (!isGenerationSubmitPayload(message.payload)) {
      const taskId = (message.payload as { taskId?: unknown } | undefined)?.taskId;
      if (typeof taskId === 'string' && taskId.length > 0) {
        sendToSidePanel({
          type: MESSAGE_TYPES.GENERATION_FEEDBACK,
          payload: { taskId, level: 'error', message: '生图请求载荷无效，请重试。' }
        });
      }
      return false;
    }
    void handleGenerationSubmit(message.payload).catch(() => undefined);
    return false;
  }

  if (message.type === MESSAGE_TYPES.GENERATION_CREATE_TASK) {
    // 同 GENERATION_SUBMIT：结果经 sidePanelPort 回传，不承诺 sendResponse。
    handleCreateTask(message.payload);
    return false;
  }

  if (message.type === MESSAGE_TYPES.GENERATION_CANCEL_TASK) {
    // 同 GENERATION_SUBMIT：不承诺 sendResponse。
    handleCancelTask(message.payload);
    return false;
  }

  return false;
});
