import { useEffect, useState } from 'react';

import type { AssetRecord } from './model';
import { getGeneratedBlob } from './idb-asset-store';

/**
 * 资产图片 src 解析结果（spec FR-21 第 5 条）。
 *
 * 渲染层（弹窗 / 侧边栏）用此结构绑定 <img src>：
 * - `src` 为可直接喂给 <img src> 的最终值；解析中或失败时为 null。
 * - `loading` 为 true 时渲染层应显示占位（避免空白）。
 * - `error` 为 true 时渲染层应显示降级占位 + 可重试（spec R18：不得静默空白）。
 */
export interface AssetImageSrc {
  src: string | null;
  loading: boolean;
  error: boolean;
}

/** 资产图片来源类型，决定字节获取路径。 */
export type AssetImageKind = 'direct' | 'indexed-db';

/**
 * 纯函数：按资产特征裁定图片来源类型（spec FR-21 第 5 条分流判据）。
 *
 * - `direct`：imageUrl 可直接作为 <img src>（采集图网页 URL；或存量 data: URL 兼容态）。
 * - `indexed-db`：imageUrl 为 IndexedDB 字节句柄（生成图），需从 IDB 取 Blob 再 createObjectURL。
 *
 * 唯一分流判据：imageUrl 是否以 `data:` 开头（存量兼容）或资产无 generatedFrom（采集图）。
 * 抽成纯函数便于独立单测，无需 jsdom。
 */
export function resolveAssetImageKind(
  asset: Pick<AssetRecord, 'imageUrl' | 'generatedFrom'>
): AssetImageKind {
  // 存量兼容：data: URL 直接透传（开发期不写迁移，存量生成图仍以 data: 形态留存）
  if (asset.imageUrl.startsWith('data:')) {
    return 'direct';
  }
  // 采集图（无 generatedFrom）走网页 URL 直透
  if (!asset.generatedFrom) {
    return 'direct';
  }
  // 生成图（有 generatedFrom 且非 data:）走 IndexedDB 字节句柄
  return 'indexed-db';
}

const directState = (src: string): AssetImageSrc => ({ src, loading: false, error: false });
const LOADING_STATE: AssetImageSrc = { src: null, loading: true, error: false };
const ERROR_STATE: AssetImageSrc = { src: null, loading: false, error: true };

/**
 * 底层 hook：按 IndexedDB 字节句柄（资产 id）异步取 Blob → createObjectURL。
 * 供「已确定是 IDB 句柄」的场景使用（如侧边栏历史项 100% 为生成图）。
 * 卸载或句柄变化时 revokeObjectURL 释放（spec FR-21 第 5 条 blob URL 生命周期）。
 *
 * handle 为 null/空时不发起查询，返回 loading 态。
 */
export function useIdbBlobSrc(handle: string | null | undefined): AssetImageSrc {
  const [state, setState] = useState<AssetImageSrc>(LOADING_STATE);

  useEffect(() => {
    if (!handle) {
      setState(LOADING_STATE);
      return;
    }
    let revoked = false;
    let objectUrl: string | null = null;
    setState(LOADING_STATE);

    void (async () => {
      try {
        const blob = await getGeneratedBlob(handle);
        if (revoked) return;
        if (!blob) {
          setState(ERROR_STATE);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setState({ src: objectUrl, loading: false, error: false });
      } catch {
        if (!revoked) setState(ERROR_STATE);
      }
    })();

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [handle]);

  return state;
}

/**
 * React hook：解析资产图片为可直接渲染的 src（spec FR-21 第 5 条）。
 *
 * - 采集图 / 存量 data: URL：同步返回原 imageUrl。
 * - 生成图：异步从 IndexedDB 取 Blob → createObjectURL，卸载或源变化时 revokeObjectURL 释放。
 *
 * 入参只需 id / imageUrl / generatedFrom 三字段，渲染层子组件按此最小契约传入。
 */
export function useAssetImageSrc(
  asset: Pick<AssetRecord, 'id' | 'imageUrl' | 'generatedFrom'>
): AssetImageSrc {
  const kind = resolveAssetImageKind(asset);

  // direct 分支同步返回；indexed-db 分支复用底层按句柄查询的 hook
  const idbState = useIdbBlobSrc(kind === 'indexed-db' ? asset.imageUrl : null);

  if (kind === 'direct') {
    return directState(asset.imageUrl);
  }
  return idbState;
}
