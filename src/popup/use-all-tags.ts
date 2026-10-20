import { useMemo } from 'react';

import type { AssetRecord } from '../shared/model';

/**
 * 从资产集合中聚合去重全部标签，按字母序稳定排序。
 *
 * 作为标签筛选 chip 的候选来源：chip 展开后列出所有已用标签，
 * 供用户多选过滤。纯函数实现便于独立单测。
 */
export function collectAllTags(assets: AssetRecord[]): string[] {
  const seen = new Set<string>();
  for (const asset of assets) {
    for (const tag of asset.tags) {
      const normalized = tag.trim().toLowerCase();
      if (normalized) {
        seen.add(normalized);
      }
    }
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

/**
 * 统计每个标签在资产集合中出现的次数。
 *
 * 用于标签 chip 下拉浮层中展示数量徽标（如 `hero (5)`）。
 */
export function countTags(assets: AssetRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const asset of assets) {
    for (const tag of asset.tags) {
      const normalized = tag.trim().toLowerCase();
      if (normalized) {
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * React hook：返回去重排序后的全部标签候选（带 memo 缓存）。
 */
export function useAllTags(assets: AssetRecord[] | undefined | null): string[] {
  return useMemo(() => collectAllTags(assets ?? []), [assets]);
}
