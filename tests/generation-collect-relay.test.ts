import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void
) => boolean | void;

const runtimeListeners: RuntimeListener[] = [];

/** background 启动会读写 chrome.storage / 注册监听，这里用最小桩避免真实 API 依赖。 */
function installChromeStub(): void {
  const noop = (): void => undefined;
  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener: noop },
      onStartup: { addListener: noop },
      onConnect: { addListener: noop },
      onMessage: {
        addListener: (listener: RuntimeListener) => runtimeListeners.push(listener)
      },
      WINDOW_ID_CURRENT: 1,
      sendMessage: vi.fn(async () => undefined)
    },
    contextMenus: {
      removeAll: vi.fn(async () => undefined),
      create: noop,
      onClicked: { addListener: noop }
    },
    sidePanel: { open: vi.fn(async () => undefined) },
    windows: { WINDOW_ID_CURRENT: 1 },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined)
      }
    },
    tabs: { sendMessage: vi.fn(async () => undefined) },
    downloads: { download: vi.fn(async () => 1) }
  } as unknown as typeof chrome;
}

vi.mock('../src/background/credentials', () => ({
  getConnectionKey: vi.fn(async () => ''),
  cleanupLegacyGenerationConfig: vi.fn(async () => undefined)
}));

let bg: typeof import('../src/background/index');

beforeAll(async () => {
  installChromeStub();
  bg = await import('../src/background/index');
});

beforeEach(() => {
  bg.setSidePanelPort(null);
});

afterEach(() => {
  vi.useRealTimers();
});

function makePort(): {
  port: chrome.runtime.Port;
  postMessage: ReturnType<typeof vi.fn>;
} {
  const postMessage = vi.fn();
  return { port: { postMessage } as unknown as chrome.runtime.Port, postMessage };
}

function lastPosted(postMessage: ReturnType<typeof vi.fn>): {
  type: string;
  payload: Record<string, unknown>;
} {
  const calls = postMessage.mock.calls;
  return calls[calls.length - 1][0] as { type: string; payload: Record<string, unknown> };
}

/** 用真实 onMessage 监听器投递 sidepanel 回执，覆盖完整中继链路（不绕过实现）。 */
function replyFromSidePanel(payload: unknown): void {
  for (const listener of runtimeListeners) {
    listener({ type: 'GENERATION_COLLECT_REPLY', payload }, {}, () => undefined);
  }
}

/**
 * spec test 49: 网页图收集的中继契约（v3.10）。
 * background 只做中继与兜底，任务状态由 sidepanel 裁定。
 */
describe('spec test 49: 收集参考图中继（background 无状态）', () => {
  it('侧边栏未连接：直接新建 reference-first 任务，不发明「已加入」', async () => {
    const result = await bg.collectReference({
      requestId: 'req_1',
      imageUrl: 'https://x.com/a.png',
      sourcePageUrl: 'https://x.com'
    });

    expect(result.outcome).toBe('fellBackToNewTask');
    expect(result.message).toContain('已新建');
  });

  it('侧边栏已连接：转发 COLLECT_REQUEST，并把 sidepanel 回执原样返回', async () => {
    const { port, postMessage } = makePort();
    bg.setSidePanelPort(port);

    const pending = bg.collectReference({
      requestId: 'req_2',
      imageUrl: 'https://x.com/b.png',
      sourcePageUrl: 'https://x.com'
    });

    const forwarded = lastPosted(postMessage);
    expect(forwarded.type).toBe('GENERATION_COLLECT_REQUEST');
    expect(forwarded.payload.imageUrl).toBe('https://x.com/b.png');

    replyFromSidePanel({
      requestId: 'req_2',
      kind: 'result',
      result: {
        outcome: 'added',
        message: '已加入任务 1（2/16 张）。',
        taskLabel: '任务 1',
        refCount: 2,
        maxRefs: 16
      }
    });

    const result = await pending;
    expect(result.outcome).toBe('added');
    expect(result.refCount).toBe(2);
  });

  it('侧边栏已连接但无响应：超时按「状态未知」拒绝，不擅自新建（避免重复任务）', async () => {
    vi.useFakeTimers();
    const { port } = makePort();
    bg.setSidePanelPort(port);

    const pending = bg.collectReference({
      requestId: 'req_3',
      imageUrl: 'https://x.com/c.png',
      sourcePageUrl: 'https://x.com'
    });

    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;

    expect(result.outcome).toBe('blocked');
    expect(result.message).toContain('未及时响应');
  });

  it('侧边栏未连接：无任务可加，退化新建（区别于超时）', async () => {
    const result = await bg.collectReference({
      requestId: 'req_4',
      imageUrl: 'https://x.com/d.png',
      sourcePageUrl: 'https://x.com'
    });
    expect(result.outcome).toBe('fellBackToNewTask');
  });

  it('目标查询：未连接时返回 no_task（角标据此直接新建，不弹浮层）', async () => {
    const target = await bg.queryCollectTarget();
    expect(target.available).toBe(false);
    expect(target.blockReason).toBe('no_task');
  });

  it('目标查询：sidepanel 回执可加入时原样返回（角标据此弹两行浮层）', async () => {
    const { port, postMessage } = makePort();
    bg.setSidePanelPort(port);

    const pending = bg.queryCollectTarget();
    const forwarded = lastPosted(postMessage);
    expect(forwarded.type).toBe('GENERATION_COLLECT_TARGET_REQUEST');

    const requestId = forwarded.payload.requestId as string;
    replyFromSidePanel({
      requestId,
      kind: 'target',
      target: { available: true, taskLabel: '任务 2', refCount: 1, maxRefs: 16 }
    });

    const target = await pending;
    expect(target.available).toBe(true);
    expect(target.taskLabel).toBe('任务 2');
  });
});
