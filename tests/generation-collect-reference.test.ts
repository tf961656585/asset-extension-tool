import { describe, expect, it } from 'vitest';

import {
  collectBlockMessage,
  decideCollect,
  describeCollectTarget
} from '../src/sidepanel/collect-decision';
import {
  createInitialGenerationTasks,
  generationTasksReducer,
  type GenerationTask,
  type GenerationTasksState
} from '../src/sidepanel/generation-session-state';
import { createTaskId } from '../src/shared/generation';

const WEB_A = 'https://x.com/a.png';
const WEB_B = 'https://x.com/b.png';

function makeTask(overrides: Partial<GenerationTask> = {}): GenerationTask {
  return {
    taskId: 'task_1',
    status: 'collecting',
    references: [{ id: 'ref_1', kind: 'web', imageUrl: WEB_A }],
    modelRecordId: 'model_1',
    protocolId: 'openai-images-v1',
    maxRefs: 16,
    maxN: 10,
    supportsReferenceImage: true,
    defaults: { size: 'auto', quality: 'auto', n: 1 },
    prompt: '',
    size: 'auto',
    quality: 'auto',
    n: 1,
    feedback: null,
    createdAt: 1,
    startedAt: null,
    history: [],
    ...overrides
  };
}

/** 建一个已完成初始化的两任务状态（聚焦第一个），复用生产 reducer。 */
function buildState(): { state: GenerationTasksState; focusedId: string } {
  let state = createInitialGenerationTasks();
  const focusedId = createTaskId();
  state = generationTasksReducer(state, {
    type: 'create-task',
    taskId: focusedId,
    references: [{ kind: 'web', imageUrl: WEB_A }],
    mode: 'reference-first',
    modelRecordId: 'model_1',
    protocolId: 'openai-images-v1',
    maxRefs: 16,
    maxN: 10,
    supportsReferenceImage: true,
    defaults: { size: 'auto', quality: 'auto', n: 1 }
  });
  state = generationTasksReducer(state, {
    type: 'create-task',
    taskId: createTaskId(),
    references: [],
    mode: 'intent-first',
    modelRecordId: 'model_1',
    protocolId: 'openai-images-v1',
    maxRefs: 16,
    maxN: 10,
    supportsReferenceImage: true,
    defaults: { size: 'auto', quality: 'auto', n: 1 }
  });
  // 焦点回到第一个任务，稳定断言序号。
  state = { ...state, activeTaskId: focusedId };
  return { state, focusedId };
}

describe('spec test 49: 网页图加入当前聚焦任务', () => {
  it('有可加入任务时：报告可加入、序号与配额', () => {
    const { state, focusedId } = buildState();
    const focused = state.tasks[focusedId];
    const index = Object.keys(state.tasks).indexOf(focusedId);

    const target = describeCollectTarget(focused, index);

    expect(target.available).toBe(true);
    expect(target.taskLabel).toBe('任务 1');
    expect(target.refCount).toBe(1);
    expect(target.maxRefs).toBe(16);
    expect(target.blockReason).toBeUndefined();
  });

  it('无聚焦任务：报告 no_task（页面侧据此退化为新建）', () => {
    const target = describeCollectTarget(null, 0);
    expect(target.available).toBe(false);
    expect(target.blockReason).toBe('no_task');
  });

  it('生成中 / 未选模型 / 不支持参考图 / 已满额分别给出稳定拒绝原因', () => {
    expect(describeCollectTarget(makeTask({ status: 'generating' }), 0).blockReason).toBe(
      'generating'
    );
    expect(describeCollectTarget(makeTask({ modelRecordId: null }), 0).blockReason).toBe(
      'model_missing'
    );
    expect(
      describeCollectTarget(makeTask({ supportsReferenceImage: false, maxRefs: 0 }), 0).blockReason
    ).toBe('references_unsupported');
    expect(
      describeCollectTarget(
        makeTask({ references: [{ id: 'r', kind: 'web', imageUrl: WEB_A }], maxRefs: 1 }),
        0
      ).blockReason
    ).toBe('references_full');
  });

  it('加入裁定：可加入 → added 且回执张数为加入后的值', () => {
    const decision = decideCollect(makeTask(), WEB_B, 0);
    expect(decision).toEqual({
      kind: 'added',
      taskLabel: '任务 1',
      refCount: 2,
      maxRefs: 16
    });
  });

  it('同一张网页图重复加入 → duplicate，不再占配额', () => {
    expect(decideCollect(makeTask(), WEB_A, 0)).toEqual({
      kind: 'duplicate',
      taskLabel: '任务 1'
    });
  });

  it('被拒绝时不产生 added，并给出可读文案', () => {
    const full = makeTask({
      references: Array.from({ length: 16 }, (_, i) => ({
        id: `r${i}`,
        kind: 'web' as const,
        imageUrl: `https://x.com/${i}.png`
      }))
    });
    const decision = decideCollect(full, WEB_B, 0);
    expect(decision.kind).toBe('blocked');
    if (decision.kind === 'blocked') {
      expect(decision.reason).toBe('references_full');
      expect(decision.message).toBe('参考图已达上限（16 张）。');
    }
  });

  it('无任务时裁定为 needs_new_task，而不是 blocked', () => {
    expect(decideCollect(null, WEB_B, 0)).toEqual({ kind: 'needs_new_task' });
    expect(collectBlockMessage('references_full', 16)).toBe('参考图已达上限（16 张）。');
  });

  it('连点：在途图计入去重（同一张不重复占配额）', () => {
    const decision = decideCollect(makeTask(), WEB_B, 0, [WEB_B]);
    expect(decision.kind).toBe('duplicate');
  });

  it('连点：在途图计入配额（最后一张位被两次点击竞争时只放行一次）', () => {
    // 已有 15 张、上限 16：第一拍加入第 16 张（在途），第二拍必须判满额而不是也加入。
    const nearFull = makeTask({
      references: Array.from({ length: 15 }, (_, i) => ({
        id: `r${i}`,
        kind: 'web' as const,
        imageUrl: `https://x.com/${i}.png`
      }))
    });
    expect(decideCollect(nearFull, WEB_B, 0)).toEqual({
      kind: 'added',
      taskLabel: '任务 1',
      refCount: 16,
      maxRefs: 16
    });

    const second = decideCollect(nearFull, 'https://x.com/c.png', 0, [WEB_B]);
    expect(second.kind).toBe('blocked');
    if (second.kind === 'blocked') {
      expect(second.reason).toBe('references_full');
    }
  });

  it('收集只改聚焦任务，不新建任务、不改变其他任务与聚焦', () => {
    const { state, focusedId } = buildState();
    const otherId = Object.keys(state.tasks).find((id) => id !== focusedId)!;
    const before = JSON.parse(JSON.stringify(state.tasks[otherId]));

    const after = generationTasksReducer(state, {
      type: 'add-reference',
      taskId: focusedId,
      reference: { kind: 'web', imageUrl: WEB_B }
    });

    expect(Object.keys(after.tasks)).toHaveLength(Object.keys(state.tasks).length);
    expect(after.activeTaskId).toBe(focusedId);
    expect(after.tasks[focusedId].references).toHaveLength(2);
    expect(after.tasks[focusedId].status).toBe('collecting');
    expect(after.tasks[otherId]).toEqual(before);
  });
});
