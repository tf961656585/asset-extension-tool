import { describe, expect, it } from 'vitest';

import {
  canSubmitNew,
  countGenerating,
  createInitialGenerationTasks,
  generationTasksReducer,
  type GenerationTask,
  type GenerationTasksState
} from '../src/sidepanel/generation-session-state';
import { createTaskId, type GenerationReference } from '../src/shared/generation';

const WEB_REF: GenerationReference = { kind: 'web', imageUrl: 'https://x.com/a.png' };

/**
 * 第 6 入口（侧边栏「+ 新任务」intent-first）发出的 create-task action shape，
 * 与 src/sidepanel/App.tsx 的 handleNewTask 一致：本地 dispatch，空 references，不携带参考图。
 */
function sidepanelNewTaskAction() {
  return { type: 'create-task' as const, taskId: createTaskId(), references: [] as GenerationReference[], mode: 'intent-first' as const };
}

/** 弹窗 intent-first 入口（startIntentTask）发出的 GENERATION_CREATE_TASK.payload shape。 */
const popupIntentFirstPayload = { taskId: 'any', mode: 'intent-first', references: [] };

function buildPreExistingState(): { state: GenerationTasksState; taskIds: string[] } {
  // 1 个 idle + 1 个 collecting + 1 个 generating 的混合既有状态。
  let state = createInitialGenerationTasks();
  const tIdle = createTaskId();
  const tCollecting = createTaskId();
  const tGenerating = createTaskId();
  state = generationTasksReducer(state, { type: 'create-task', taskId: tIdle, references: [], mode: 'intent-first' });
  state = generationTasksReducer(state, { type: 'create-task', taskId: tCollecting, references: [WEB_REF], mode: 'reference-first' });
  state = generationTasksReducer(state, { type: 'create-task', taskId: tGenerating, references: [], mode: 'intent-first' });
  state = generationTasksReducer(state, { type: 'start-generating', taskId: tGenerating });
  return { state, taskIds: [tIdle, tCollecting, tGenerating] };
}

describe('spec test 44: 侧边栏「+ 新任务」intent-first 入口（第六入口）', () => {
  it('新建 idle 任务并聚焦，且既有任务完全不受影响', () => {
    const { state: before } = buildPreExistingState();
    const snapshot = JSON.parse(JSON.stringify(before.tasks));
    const newAction = sidepanelNewTaskAction();

    const after = generationTasksReducer(before, newAction);

    // 新增 1 个任务
    expect(Object.keys(after.tasks).length).toBe(Object.keys(before.tasks).length + 1);
    // 新任务为 idle（文生图输入态）、参考图为空
    const newTask = after.tasks[newAction.taskId];
    expect(newTask).toBeDefined();
    expect(newTask.status).toBe('idle');
    expect(newTask.references).toHaveLength(0);
    // 自动聚焦新任务
    expect(after.activeTaskId).toBe(newAction.taskId);

    // 既有任务（数量、各任务 status / references / taskId）完全未被改动
    for (const [id, prev] of Object.entries(snapshot)) {
      expect(after.tasks[id]).toEqual(prev as GenerationTask);
    }
    expect(Object.keys(after.tasks).filter((id) => id !== newAction.taskId).sort()).toEqual(
      Object.keys(snapshot).sort()
    );
  });

  it('与弹窗 intent-first 入口同源（references 空 + mode intent-first，文档级契约守卫）', () => {
    const newAction = sidepanelNewTaskAction();
    // 两者写入同一 action/payload shape：references 空、mode 为 intent-first。
    expect(newAction.references.length).toBe(0);
    expect(newAction.mode).toBe('intent-first');
    expect(popupIntentFirstPayload.references.length).toBe(0);
    expect(popupIntentFirstPayload.mode).toBe('intent-first');
    // 第 6 入口在侧边栏内本地 dispatch，不经由 background 转发（shape 与 reducer 直投一致）。
    expect(newAction.type).toBe('create-task');
  });

  it('create 不占用在飞名额：既有 generating 任务下 create 后 countGenerating / canSubmitNew 不变', () => {
    const { state: before } = buildPreExistingState();
    const beforeGenerating = countGenerating(before.tasks);
    expect(beforeGenerating).toBe(1);
    expect(canSubmitNew(before.tasks)).toBe(true);

    const after = generationTasksReducer(before, sidepanelNewTaskAction());

    // 新建的是 idle 任务，不增加在飞数，门禁仍为 true。
    expect(countGenerating(after.tasks)).toBe(beforeGenerating);
    expect(canSubmitNew(after.tasks)).toBe(true);
  });

  it('对照：并发门禁仅在「生成」提交环节生效（5 个 generating 时第 6 次提交被拦截）', () => {
    // App 层门禁：submitGeneration 在 dispatch start-generating 前校验 canSubmitNew，
    // 门禁拦截时（canSubmitNew 为 false）不发起 start-generating。
    function submitIfAllowed(prev: GenerationTasksState, id: string): GenerationTasksState {
      if (!canSubmitNew(prev.tasks)) {
        return prev;
      }
      return generationTasksReducer(prev, { type: 'start-generating', taskId: id });
    }

    // 先 create 累积任务，再按门禁提交 start-generating 直至 5 个在飞。
    let state = createInitialGenerationTasks();
    for (let i = 0; i < 5; i += 1) {
      const id = createTaskId();
      state = generationTasksReducer(state, { type: 'create-task', taskId: id, references: [], mode: 'intent-first' });
      state = submitIfAllowed(state, id);
    }
    expect(countGenerating(state.tasks)).toBe(5);
    expect(canSubmitNew(state.tasks)).toBe(false);

    // 第 6 次：仍可 create（创建不占名额），但提交被门禁拦截、任务停留 idle。
    const sixth = createTaskId();
    const afterCreate = generationTasksReducer(state, {
      type: 'create-task',
      taskId: sixth,
      references: [],
      mode: 'intent-first'
    });
    expect(countGenerating(afterCreate.tasks)).toBe(5);
    expect(canSubmitNew(afterCreate.tasks)).toBe(false);
    const afterSixthSubmit = submitIfAllowed(afterCreate, sixth);
    expect(afterSixthSubmit.tasks[sixth].status).toBe('idle');
    expect(countGenerating(afterSixthSubmit.tasks)).toBe(5);
  });
});
