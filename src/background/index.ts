import {
  createAssetRecord,
  upsertAsset,
  type CreateAssetInput
} from '../shared/model';
import {
  MESSAGE_TYPES,
  isGenerationSubmitPayload,
  type CollectResult,
  type GenerationCancelTaskPayload,
  type GenerationCollectReferencePayload,
  type GenerationCollectReplyPayload,
  type GenerationCollectRequestPayload,
  type GenerationCollectTargetRequestPayload,
  type GenerationCreateTaskPayload,
  type GenerationSubmitPayload,
  type RuntimeMessage,
  type SaveImagePayload,
  type SaveImageResponse
} from '../shared/messages';
import type { CollectTarget } from '../shared/generation';
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
const CONTEXT_MENU_COLLECT_ID = 'wyjh-collect-into-task';
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

/**
 * 挂起的收集类请求：requestId → 解挂句柄。v3.10
 * background 只做中继与超时兜底，不持有任务状态（可加入与否由 sidepanel 计算）。
 */
interface PendingCollectRequest {
  resolveReply: (value: CollectTarget | CollectResult) => void;
  /** 侧边栏在回执前断开：任务随之消失，按「确实没有任务」解挂。 */
  resolveNoPort: () => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingCollects = new Map<string, PendingCollectRequest>();

/** 收集类请求的中继超时：侧边栏已连接但无响应时兜底，避免页面侧一直悬挂。 */
const COLLECT_RELAY_TIMEOUT_MS = 1500;

/**
 * 中继结果。必须区分三种情况——「未连接」意味着确实没有任务（可安全退化新建），
 * 「超时」意味着状态未知（不能擅自新建，否则可能与已生效的加入动作并存出多余任务）。
 */
type RelayOutcome =
  | { status: 'no-port' }
  | { status: 'timeout' }
  | { status: 'reply'; value: CollectTarget | CollectResult };

function relayToSidePanel(requestId: string, messages: RuntimeMessage[]): Promise<RelayOutcome> {
  if (!sidePanelPort) {
    return Promise.resolve({ status: 'no-port' });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCollects.delete(requestId);
      resolve({ status: 'timeout' });
    }, COLLECT_RELAY_TIMEOUT_MS);
    pendingCollects.set(requestId, {
      resolveReply: (value) => resolve({ status: 'reply', value }),
      resolveNoPort: () => resolve({ status: 'no-port' }),
      timer
    });
    for (const message of messages) {
      sidePanelPort?.postMessage(message);
    }
  });
}

/** sidepanel 回执：按 requestId 解挂对应页面侧请求。 */
function resolvePendingCollect(payload: GenerationCollectReplyPayload): void {
  const pending = pendingCollects.get(payload.requestId);
  if (!pending) {
    return;
  }
  if (payload.kind === 'target' && payload.target) {
    pending.resolveReply(payload.target);
  } else if (payload.kind === 'result' && payload.result) {
    pending.resolveReply(payload.result);
  } else {
    // 回执载荷不完整：不解挂，交由超时兜底，避免调用方拿到空结果。
    return;
  }
  clearTimeout(pending.timer);
  pendingCollects.delete(payload.requestId);
}

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
        '当前模型暂不支持，请到设置页检查接口类型。'
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
          message: '生成超时，请重试。'
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
        message: `生成完成，${created.length} 张已存入资产库`,
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

/** 建任务并转发给 sidepanel（不含打开侧边栏，避免同一动作重复调用 open）。 */
function createTask(payload: GenerationCreateTaskPayload): void {
  if (sidePanelPort) {
    sendToSidePanel({ type: MESSAGE_TYPES.GENERATION_CREATE_TASK, payload });
  } else {
    pendingCreateTasks.push(payload);
  }
}

/** 收到 CREATE_TASK：打开侧边栏（若未连则缓冲），并将其转发给 sidepanel 由 UI 建任务。background 不持有任务状态。 */
function handleCreateTask(payload: GenerationCreateTaskPayload): void {
  void openSidePanel();
  createTask(payload);
}

const NO_TASK_TARGET: CollectTarget = {
  available: false,
  refCount: 0,
  maxRefs: 0,
  blockReason: 'no_task'
};

/**
 * 查询当前聚焦任务的可加入状态（v3.10）：经 sidepanel 端口往返，超时或未连接按「无任务」兜底。
 * 角标点击时据此决定是否先弹选择浮层；查询本身不创建任务。
 */
export async function queryCollectTarget(): Promise<CollectTarget> {
  const requestId = createTaskId();
  const payload: GenerationCollectTargetRequestPayload = { requestId };
  const outcome = await relayToSidePanel(requestId, [
    { type: MESSAGE_TYPES.GENERATION_COLLECT_TARGET_REQUEST, payload }
  ]);
  // 查询是只读的：无论未连接还是超时，都按「无任务」处理（角标直接新建，不弹浮层）。
  if (outcome.status === 'reply' && 'available' in outcome.value) {
    return outcome.value;
  }
  return NO_TASK_TARGET;
}

/**
 * 把网页图加入侧边栏当前聚焦任务（v3.10）。
 * 侧边栏已连接：中继由 sidepanel 决定结果（含无任务时自行新建）。
 * 侧边栏未连接：没有可加入的任务，直接按 reference-first 新建，并把结果告知页面侧。
 * 侧边栏已连接但超时：状态未知，**不得擅自新建**——否则一次点击可能既加进旧任务又多出一个新任务。
 */
export async function collectReference(
  payload: GenerationCollectReferencePayload
): Promise<CollectResult> {
  // 收集动作本身也要保证侧边栏可见：加入成功需要用户看到结果落在哪个任务。
  void openSidePanel();
  const request: GenerationCollectRequestPayload = {
    requestId: payload.requestId,
    imageUrl: payload.imageUrl,
    sourcePageUrl: payload.sourcePageUrl
  };
  const outcome = await relayToSidePanel(payload.requestId, [
    { type: MESSAGE_TYPES.GENERATION_COLLECT_REQUEST, payload: request }
  ]);

  if (outcome.status === 'reply' && 'outcome' in outcome.value) {
    return outcome.value;
  }
  if (outcome.status === 'timeout') {
    return {
      outcome: 'blocked',
      message: '侧边栏未及时响应，请确认侧边栏已打开后重试。',
      blockReason: 'relay_timeout'
    };
  }

  createTask({
    taskId: createTaskId(),
    mode: 'reference-first',
    references: [{ kind: 'web', imageUrl: payload.imageUrl }]
  });
  return {
    outcome: 'fellBackToNewTask',
    message: '暂无生图任务，已新建任务并加入。',
    taskLabel: '任务 1',
    refCount: 1
  };
}

/** 右键菜单入口：收集结果无 sendResponse 通道，改用页面 toast 回执（content script 监听）。 */
async function collectReferenceFromContextMenu(
  imageUrl: string,
  sourcePageUrl: string,
  tabId: number | undefined
): Promise<void> {
  const result = await collectReference({
    requestId: createTaskId(),
    imageUrl,
    sourcePageUrl
  });

  if (!tabId) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.GENERATION_COLLECT_FEEDBACK,
      payload: { ok: result.outcome !== 'blocked', message: result.message }
    });
  } catch {
    // 无法投递内容脚本消息（如 chrome:// 页面）时忽略，侧边栏内仍能看到结果。
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
  // v3.10：收集动作与生图入口并列且排在前面——在已有任务时它才是高频意图。
  chrome.contextMenus.create({
    id: CONTEXT_MENU_COLLECT_ID,
    title: '加入当前生图任务',
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
    // 挂起的收集中继随之失效：侧边栏断开意味着其内存任务一并消失，按「确实没有任务」解挂。
    for (const [requestId, pending] of pendingCollects) {
      clearTimeout(pending.timer);
      pendingCollects.delete(requestId);
      pending.resolveNoPort();
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

  if (info.menuItemId === CONTEXT_MENU_COLLECT_ID) {
    // 收集路径（v3.10）：把图加入当前聚焦任务；没有可加入任务时退化为新建。
    void collectReferenceFromContextMenu(info.srcUrl, sourcePageUrl, tab?.id);
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
          payload: { taskId, level: 'error', message: '请求内容有误，请重试。' }
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

  if (message.type === MESSAGE_TYPES.GENERATION_COLLECT_REFERENCE) {
    // 页面侧收集：结果经 sendResponse 直接回给发起点击的页面（角标路径需要即时 toast）。
    void collectReference(message.payload)
      .then((result) => sendResponse(result))
      .catch(() => {
        // 意外失败不冒充「无任务」——那会让页面侧以为可以安全新建。
        sendResponse({
          outcome: 'blocked',
          message: '加入参考图失败，请重试。',
          blockReason: 'relay_timeout'
        } satisfies CollectResult);
      });
    return true;
  }

  if (message.type === MESSAGE_TYPES.GENERATION_COLLECT_TARGET_QUERY) {
    // 角标点击前查询：决定是否先弹两行选择浮层。超时/未连接按「无任务」兜底（直接新建）。
    void queryCollectTarget()
      .then((target) => sendResponse(target))
      .catch(() => sendResponse(NO_TASK_TARGET satisfies CollectTarget));
    return true;
  }

  if (message.type === MESSAGE_TYPES.GENERATION_COLLECT_REPLY) {
    // sidepanel 中继回执：解挂对应页面侧请求，不缓存任务状态。
    resolvePendingCollect(message.payload);
    return false;
  }

  return false;
});
