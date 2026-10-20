import type { AssetRecord } from '../shared/model';

export interface MediaCardSummary {
  /** 域名（hover scrim 单行摘要的主标识）。 */
  primary: string;
  /** 相对时间（如“2 天前”），与域名组合成单行摘要。 */
  relativeTime: string;
  /** 生成图微标签（图生图「✨ 生成 · 源 N 张」/ 文生图「✨ 文生图」），采集图为空。 */
  generationBadge?: { text: string };
}

export interface AssetCardDetail {
  sourcePageUrl: string;
  imageUrl: string;
  savedAt: string;
  folderName: string;
  tags: string;
}

export function shortenText(value: string, maxLength = 42): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

export function formatSavedAt(isoTime: string): string {
  const time = new Date(isoTime);
  if (Number.isNaN(time.getTime())) {
    return isoTime;
  }
  return time.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

/**
 * 相对时间表达（hover scrim 单行摘要用）。
 * 规则见 popup-ui-wireframe-v1.md「资产卡片 Hover/Focus 轻量信息态」。
 * @param isoTime 资产保存时间（ISO 字符串）
 * @param now     当前时间基准，默认 new Date()（注入便于单测）
 */
export function formatRelativeTime(isoTime: string, now: Date = new Date()): string {
  const time = new Date(isoTime);
  if (Number.isNaN(time.getTime())) {
    return isoTime;
  }
  const diffMs = now.getTime() - time.getTime();
  const futureOrInvalid = diffMs < 0;
  if (futureOrInvalid) {
    return isoTime;
  }
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return '刚刚';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days} 天前`;
  }
  // ≥ 7 天：绝对日期；年份与当前一致时省略年。
  const sameYear = time.getFullYear() === now.getFullYear();
  const mm = String(time.getMonth() + 1).padStart(2, '0');
  const dd = String(time.getDate()).padStart(2, '0');
  return sameYear ? `${mm}-${dd}` : `${time.getFullYear()}-${mm}-${dd}`;
}

export function buildAssetCardViewModel(asset: AssetRecord, folderName: string): {
  summary: MediaCardSummary;
  detail: AssetCardDetail;
} {
  const generationBadge =
    asset.generatedFrom?.mode === 'image-to-image'
      ? { text: `✨ 生成 · 源 ${asset.generatedFrom.sourceRefs.length} 张` }
      : asset.generatedFrom?.mode === 'text-to-image'
        ? { text: '✨ 文生图' }
        : undefined;

  return {
    summary: {
      primary: asset.sourceDomain,
      relativeTime: formatRelativeTime(asset.savedAt),
      generationBadge
    },
    detail: {
      sourcePageUrl: asset.sourcePageUrl,
      imageUrl: asset.imageUrl,
      savedAt: formatSavedAt(asset.savedAt),
      folderName,
      tags: asset.tags.length > 0 ? asset.tags.join(', ') : '无标签'
    }
  };
}
