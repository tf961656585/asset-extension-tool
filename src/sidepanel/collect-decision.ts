import type { CollectBlockReason, CollectTarget } from '../shared/generation';
import type { GenerationTask } from './generation-session-state';

/**
 * 网页侧「加入当前生图任务」的目标计算（v3.10）。
 * `task` 为侧边栏当前聚焦任务；`taskIndex` 是它在任务列表中的序号（0 起），用于展示「任务 N」。
 * 无聚焦任务或侧边栏未打开时返回 `no_task`，调用方据此退化为新建任务。
 */
export function describeCollectTarget(
  task: GenerationTask | null,
  taskIndex: number
): CollectTarget {
  if (!task) {
    return { available: false, refCount: 0, maxRefs: 0, blockReason: 'no_task' };
  }

  const taskLabel = `任务 ${taskIndex + 1}`;
  const base = {
    taskLabel,
    refCount: task.references.length,
    maxRefs: task.modelRecordId ? task.maxRefs : 0
  };

  if (task.status === 'generating') {
    return { ...base, available: false, blockReason: 'generating' };
  }
  if (!task.modelRecordId) {
    return { ...base, available: false, blockReason: 'model_missing' };
  }
  if (!task.supportsReferenceImage) {
    return { ...base, available: false, blockReason: 'references_unsupported' };
  }
  if (task.references.length >= task.maxRefs) {
    return { ...base, available: false, blockReason: 'references_full' };
  }
  return { ...base, available: true };
}

/** 拒绝原因 → 页面侧可读文案（与 target 查询、加入结果共用，避免两处措辞漂移）。 */
const BLOCK_MESSAGES: Record<CollectBlockReason, string> = {
  no_task: '当前没有可加入的生图任务。',
  relay_timeout: '侧边栏未及时响应，请确认侧边栏已打开后重试。',
  generating: '任务正在生成，完成后可继续加入。',
  model_missing: '请先在侧边栏选择模型。',
  references_unsupported: '当前模型不支持参考图。',
  references_full: '参考图已达上限。'
};

export function collectBlockMessage(reason: CollectBlockReason, maxRefs?: number): string {
  if (reason === 'references_full' && typeof maxRefs === 'number' && maxRefs > 0) {
    return `参考图已达上限（${maxRefs} 张）。`;
  }
  return BLOCK_MESSAGES[reason];
}

export type CollectDecision =
  | { kind: 'added'; taskLabel: string; refCount: number; maxRefs: number }
  | { kind: 'duplicate'; taskLabel: string }
  | { kind: 'blocked'; reason: CollectBlockReason; message: string; maxRefs: number }
  | { kind: 'needs_new_task' };

/**
 * 纯函数：裁定「这张网页图能否加入该任务」（v3.10）。
 * 与 `add-reference` reducer 的门禁保持一致；重复图按 imageUrl 判定，避免同图反复占配额。
 * `pendingUrls` 是已受理但尚未反映到 `task.references` 的图（连点场景）——配额与张数必须把它算进去，
 * 否则两次快速点击会各自看到「还有空位」而一起通过。
 */
export function decideCollect(
  task: GenerationTask | null,
  imageUrl: string,
  taskIndex: number,
  pendingUrls: readonly string[] = []
): CollectDecision {
  const target = describeCollectTarget(task, taskIndex);

  // 无聚焦任务不是「拒绝」：页面侧按新建任务处理。
  if (!task) {
    return { kind: 'needs_new_task' };
  }

  const taskLabel = target.taskLabel as string;
  const block = (reason: CollectBlockReason, maxRefs: number): CollectDecision => ({
    kind: 'blocked',
    reason,
    message: collectBlockMessage(reason, maxRefs),
    maxRefs
  });

  // 生成中 / 未选模型 / 不支持参考图：与张数无关，先判。
  if (target.blockReason && target.blockReason !== 'references_full') {
    return block(target.blockReason, target.maxRefs);
  }

  const effectiveCount = task.references.length + pendingUrls.length;
  if (effectiveCount >= task.maxRefs) {
    return block('references_full', task.maxRefs);
  }

  const duplicate =
    task.references.some((ref) => ref.kind === 'web' && ref.imageUrl === imageUrl) ||
    pendingUrls.includes(imageUrl);
  if (duplicate) {
    return { kind: 'duplicate', taskLabel };
  }

  return {
    kind: 'added',
    taskLabel,
    refCount: effectiveCount + 1,
    maxRefs: task.maxRefs
  };
}
