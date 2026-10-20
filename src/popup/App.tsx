import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement
} from 'react';

import { buildAssetCardViewModel } from './card-view-model';
import { FilterChip } from './FilterChip';
import { FilterPopover } from './FilterPopover';
import { createInitialPopupUIState, popupUIReducer } from './ui-state';
import {
  MESSAGE_BUBBLE_AUTO_DISMISS_MS,
  createInitialNotice,
  getAssetsEmptyStateText,
  shouldRenderNotice,
  type NoticeState
} from './view-contract';
import {
  DEFAULT_FOLDER_ID,
  addFolder,
  buildManagedRootDir,
  filterAssets,
  parseTagInput,
  updateAssetFolder,
  updateAssetTags,
  type AssetRecord,
  type ExtensionData
} from '../shared/model';
import { loadExtensionData, mutateExtensionData } from '../shared/storage';
import { MESSAGE_TYPES } from '../shared/messages';
import { createTaskId, type GenerationReference } from '../shared/generation';
import { buildCopyImageNotice, copyImageBlob, copyImageByUrl } from './copy-image';
import { FolderIcon, CopyIcon, EditIcon, PlusIcon, SparkleIcon, EmptyImageIcon, HelpIcon } from './Icons';
import { HELP_SECTIONS } from './help-content';
import { HelpView } from './HelpView';
import { GenerationSettings } from './GenerationSettings';
import { countTags, useAllTags } from './use-all-tags';
import { useAssetImageSrc } from '../shared/use-asset-image-src';
import { getGeneratedBlob } from '../shared/idb-asset-store';

/**
 * 资产缩略图：采集图直透网页 URL，生成图走 IndexedDB 字节句柄（spec FR-21 第 5 条）。
 * 独立子组件以使 hook 可在列表 .map() 内合法调用；加载中/失败显示占位，不静默空白（spec R18）。
 */
function AssetThumb({ asset }: { asset: AssetRecord }): ReactElement {
  const { src, loading, error } = useAssetImageSrc(asset);
  if (loading || !src) {
    return <div className="media-thumb-placeholder" aria-label={error ? '加载失败' : '加载中'} />;
  }
  return <img src={src} alt="资产缩略图" loading="lazy" />;
}

interface AssetEditorDraft {
  assetId: string;
  folderId: string;
  tagText: string;
}

function App() {
  const [uiState, dispatchUI] = useReducer(popupUIReducer, createInitialPopupUIState());
  const [data, setData] = useState<ExtensionData | null>(null);
  const [saveBaseDirDraft, setSaveBaseDirDraft] = useState('');
  const [folderName, setFolderName] = useState('');
  const [notice, setNotice] = useState<NoticeState | null>(createInitialNotice());
  const [editorDraft, setEditorDraft] = useState<AssetEditorDraft | null>(null);
  const [isSourceInfoExpanded, setIsSourceInfoExpanded] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  // 筛选 chip 浮层开合：纯视图层状态，同一时刻只允许一个浮层打开。
  const [openPopover, setOpenPopover] = useState<'folder' | 'tag' | null>(null);

  const editorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const editorPrimaryFieldRef = useRef<HTMLSelectElement | null>(null);

  async function refreshData(): Promise<void> {
    const loaded = await loadExtensionData();
    setData(loaded);
    setSaveBaseDirDraft(loaded.settings.saveBaseDir);
  }

  useEffect(() => {
    void refreshData();
  }, []);

  useEffect(() => {
    if (!shouldRenderNotice(notice)) {
      return;
    }

    const dismissTimer = window.setTimeout(() => {
      setNotice(createInitialNotice());
    }, MESSAGE_BUBBLE_AUTO_DISMISS_MS);

    return () => window.clearTimeout(dismissTimer);
  }, [notice]);

  const filteredAssets = useMemo(() => {
    if (!data) {
      return [];
    }

    return filterAssets(data, {
      siteKeyword: uiState.filters.siteKeyword,
      folderId: uiState.filters.folderFilter,
      tags: parseTagInput(uiState.filters.tagFilter)
    });
  }, [data, uiState.filters.folderFilter, uiState.filters.siteKeyword, uiState.filters.tagFilter]);

  const folderNameById = useMemo(() => {
    return Object.fromEntries((data?.folders ?? []).map((folder) => [folder.id, folder.name]));
  }, [data?.folders]);

  const editingAsset = useMemo(() => {
    if (!data || !uiState.editingAssetId) {
      return null;
    }
    return data.assets.find((asset) => asset.id === uiState.editingAssetId) ?? null;
  }, [data, uiState.editingAssetId]);

  const managedRootDir = useMemo(() => buildManagedRootDir(saveBaseDirDraft), [saveBaseDirDraft]);

  const editingAssetFolderName = useMemo(() => {
    if (!editingAsset) {
      return '未分类';
    }
    return (
      folderNameById[editingAsset.folderId ?? DEFAULT_FOLDER_ID] ??
      folderNameById[DEFAULT_FOLDER_ID] ??
      '未分类'
    );
  }, [editingAsset, folderNameById]);

  const editingAssetCard = useMemo(() => {
    if (!editingAsset) {
      return null;
    }
    return buildAssetCardViewModel(editingAsset, editingAssetFolderName);
  }, [editingAsset, editingAssetFolderName]);

  const allTags = useAllTags(data?.assets);
  const tagCounts = useMemo(() => countTags(data?.assets ?? []), [data?.assets]);

  const assetCountByFolder = useMemo(() => {
    const counts = new Map<string, number>();
    for (const asset of data?.assets ?? []) {
      const folderId = asset.folderId ?? DEFAULT_FOLDER_ID;
      counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
    }
    return counts;
  }, [data?.assets]);

  useEffect(() => {
    if (!editingAsset) {
      setEditorDraft(null);
      setIsSourceInfoExpanded(false);
      setShowDiscardConfirm(false);
      return;
    }

    setEditorDraft({
      assetId: editingAsset.id,
      folderId: editingAsset.folderId ?? DEFAULT_FOLDER_ID,
      tagText: editingAsset.tags.join(', ')
    });
    setIsSourceInfoExpanded(false);
    setShowDiscardConfirm(false);
  }, [editingAsset?.id]);

  useEffect(() => {
    if (!editingAsset) {
      return;
    }

    const handle = requestAnimationFrame(() => {
      editorPrimaryFieldRef.current?.focus();
    });

    return () => cancelAnimationFrame(handle);
  }, [editingAsset?.id]);

  const isEditorDirty = useMemo(() => {
    if (!editingAsset || !editorDraft || editorDraft.assetId !== editingAsset.id) {
      return false;
    }

    const currentFolderId = editingAsset.folderId ?? DEFAULT_FOLDER_ID;
    const nextFolderId = editorDraft.folderId || DEFAULT_FOLDER_ID;
    if (currentFolderId !== nextFolderId) {
      return true;
    }

    const currentTagsKey = parseTagInput(editingAsset.tags.join(', ')).join('|');
    const nextTagsKey = parseTagInput(editorDraft.tagText).join('|');
    return currentTagsKey !== nextTagsKey;
  }, [editingAsset, editorDraft]);

  async function updateSaveBaseDir(): Promise<void> {
    const normalizedDraft = saveBaseDirDraft.trim();

    try {
      await mutateExtensionData((prev) => ({
        ...prev,
        settings: {
          ...prev.settings,
          saveBaseDir: normalizedDraft
        }
      }));

      await refreshData();
      setNotice({
        type: 'success',
        message: normalizedDraft
          ? `保存位置已更新，后续图片会保存到 ${buildManagedRootDir(normalizedDraft)}。`
          : `保存位置已重置，后续图片会保存到 ${buildManagedRootDir('')}。`
      });
    } catch (error: unknown) {
      setNotice({
        type: 'error',
        message: error instanceof Error ? error.message : '更新保存位置失败'
      });
    }
  }

  async function createFolder(): Promise<void> {
    const nextName = folderName.trim();
    if (!nextName) {
      return;
    }

    let createdFolderId = '';
    try {
      await mutateExtensionData((prev) => {
        const result = addFolder(prev, nextName);
        createdFolderId = result.folder.id;
        return result.data;
      });
      await refreshData();
      setFolderName('');
      setOpenPopover(null);
      // 新建后自动选中该文件夹，符合 FR-11「新建后自动选中」契约。
      if (createdFolderId) {
        dispatchUI({ type: 'set-folder-filter', value: createdFolderId });
      }
      setNotice({ type: 'success', message: `文件夹「${nextName}」已创建。` });
    } catch (error: unknown) {
      setNotice({
        type: 'error',
        message: error instanceof Error ? error.message : '新建文件夹失败'
      });
    }
  }

  async function copyAsset(asset: AssetRecord): Promise<void> {
    try {
      // v3.7 分流（spec FR-21 第 6 条）：生成图从 IndexedDB 取 Blob 直接写剪贴板，不 fetch 句柄；
      // 采集图（或存量 data: URL）沿用 copyImageByUrl。
      const isGenerated = Boolean(asset.generatedFrom) && !asset.imageUrl.startsWith('data:');
      let copyResult;
      if (isGenerated) {
        const blob = await getGeneratedBlob(asset.imageUrl);
        if (!blob) {
          throw new Error('生成图字节缺失');
        }
        copyResult = await copyImageBlob(blob);
      } else {
        copyResult = await copyImageByUrl(asset.imageUrl);
      }
      setNotice(buildCopyImageNotice(copyResult));
    } catch (error: unknown) {
      setNotice({
        type: 'error',
        message: error instanceof Error ? `复制失败：${error.message}` : '复制失败'
      });
    }
  }

  function showDownload(asset: AssetRecord): void {
    chrome.downloads.show(asset.downloadId);
  }

  function dismissNoticeBubble(): void {
    setNotice(createInitialNotice());
  }

  function openSettingsView(): void {
    dispatchUI({ type: 'switch-view', view: 'settings' });
  }

  function backToAssetsView(): void {
    dispatchUI({ type: 'switch-view', view: 'assets' });
  }

  // 打开侧边栏：popup 内调用带用户手势上下文，可由 background 接管生图闭环。
  function openSidePanel(): void {
    try {
      void chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    } catch {
      // 手势上下文缺失时忽略，由用户手动打开 sidepanel。
    }
  }

  // reference-first 入口：每次点击创建一个新任务（首张参考图 + collecting），并打开侧边栏。
  function toReferenceFromAsset(asset: AssetRecord): GenerationReference {
    return { kind: 'asset', assetId: asset.id, imageUrl: asset.imageUrl };
  }

  function generateFromAsset(asset: AssetRecord): void {
    const taskId = createTaskId();
    void chrome.runtime
      .sendMessage({
        type: MESSAGE_TYPES.GENERATION_CREATE_TASK,
        payload: {
          taskId,
          mode: 'reference-first',
          references: [toReferenceFromAsset(asset)]
        }
      })
      .catch(() => undefined);
    openSidePanel();
  }

  // intent-first 入口：每次点击创建一个新 idle 任务（文生图输入态），并打开侧边栏。
  function startIntentTask(): void {
    const taskId = createTaskId();
    void chrome.runtime
      .sendMessage({
        type: MESSAGE_TYPES.GENERATION_CREATE_TASK,
        payload: {
          taskId,
          mode: 'intent-first',
          references: []
        }
      })
      .catch(() => undefined);
    openSidePanel();
  }

  function resetFilters(): void {
    dispatchUI({ type: 'set-site-keyword', value: '' });
    dispatchUI({ type: 'set-folder-filter', value: 'all' });
    dispatchUI({ type: 'set-tag-filter', value: '' });
  }

  function enterAssetEdit(asset: AssetRecord, trigger: HTMLButtonElement): void {
    editorTriggerRef.current = trigger;
    dispatchUI({ type: 'enter-asset-edit', assetId: asset.id });
  }

  function restoreFocusToTrigger(): void {
    const trigger = editorTriggerRef.current;
    if (!trigger || !trigger.isConnected) {
      return;
    }

    requestAnimationFrame(() => {
      trigger.focus();
    });
  }

  function leaveAssetEditNow(): void {
    dispatchUI({ type: 'leave-asset-edit' });
    setEditorDraft(null);
    setIsSourceInfoExpanded(false);
    setShowDiscardConfirm(false);
    restoreFocusToTrigger();
  }

  function requestLeaveAssetEdit(): void {
    if (isEditorDirty) {
      setShowDiscardConfirm(true);
      return;
    }
    leaveAssetEditNow();
  }

  async function saveAssetEditor(): Promise<void> {
    if (!editingAsset || !editorDraft) {
      return;
    }

    const nextFolderId = editorDraft.folderId || DEFAULT_FOLDER_ID;
    const nextTags = parseTagInput(editorDraft.tagText);

    try {
      await mutateExtensionData((prev) => {
        const withFolder = updateAssetFolder(prev, editingAsset.id, nextFolderId);
        return updateAssetTags(withFolder, editingAsset.id, nextTags);
      });

      await refreshData();
      leaveAssetEditNow();
      setNotice({ type: 'success', message: '分类信息已更新。' });
    } catch (error: unknown) {
      setNotice({
        type: 'error',
        message: error instanceof Error ? error.message : '更新分类失败'
      });
    }
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape') {
      return;
    }

    event.stopPropagation();
    requestLeaveAssetEdit();
  }

  const hasActiveFilters =
    uiState.filters.siteKeyword.trim().length > 0 ||
    (uiState.filters.folderFilter.trim().length > 0 && uiState.filters.folderFilter !== 'all') ||
    uiState.filters.tagFilter.trim().length > 0;

  const assetsEmptyText = hasActiveFilters
    ? '当前筛选条件下没有资产，建议调整筛选或清空筛选。'
    : getAssetsEmptyStateText();

  // 筛选 chip 派生量：选中态、回显文本、标签集合与多选切换。
  const folderFilterActive =
    uiState.filters.folderFilter.trim().length > 0 && uiState.filters.folderFilter !== 'all';

  const folderChipLabel = folderFilterActive
    ? folderNameById[uiState.filters.folderFilter] ?? '文件夹'
    : '文件夹';

  const selectedTagSet = useMemo(
    () => new Set(parseTagInput(uiState.filters.tagFilter)),
    [uiState.filters.tagFilter]
  );
  const tagFilterActive = selectedTagSet.size > 0;
  const tagChipLabel = tagFilterActive ? Array.from(selectedTagSet).join(', ') : '标签';

  function toggleTagFilter(tag: string): void {
    const next = new Set(selectedTagSet);
    if (next.has(tag)) {
      next.delete(tag);
    } else {
      next.add(tag);
    }
    dispatchUI({ type: 'set-tag-filter', value: Array.from(next).join(', ') });
  }

  return (
    <main className="shell">
      <header className="popup-head compact-head">
        <div className="popup-head-brand">
          <span className="popup-head-icon" aria-hidden="true">🖼</span>
          {uiState.view === 'assets' ? (
            <span className="popup-head-title">
              资产库<span className="popup-head-count">{data?.assets.length ?? 0} 张</span>
            </span>
          ) : (
            <span className="popup-head-title">
              {uiState.view === 'settings' ? '设置' : uiState.view === 'help' ? '使用帮助' : '编辑分类'}
            </span>
          )}
        </div>
        {uiState.view === 'assets' ? (
          <>
            <button className="view-switch popup-head-gen" onClick={() => startIntentTask()} aria-label="打开生图侧边栏">
              <SparkleIcon />
              生图
            </button>
            <button className="view-switch" onClick={openSettingsView} aria-label="打开设置">
              设置
            </button>
            <button
              className="view-switch popup-head-help"
              onClick={() => dispatchUI({ type: 'switch-view', view: 'help' })}
              aria-label="打开使用帮助"
            >
              <HelpIcon />
            </button>
          </>
        ) : (
          <button className="view-switch" onClick={backToAssetsView} aria-label="返回资产页">
            返回
          </button>
        )}
      </header>

      {shouldRenderNotice(notice) ? (
        <section
          className={`message-bubble message-bubble-${notice.type}`}
          role="status"
          aria-live={notice.type === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          <span className="message-bubble-text">{notice.message}</span>
          <button
            type="button"
            className="message-bubble-close"
            aria-label="关闭提示气泡"
            onClick={dismissNoticeBubble}
          >
            关闭
          </button>
        </section>
      ) : null}

      {uiState.view === 'assets' ? (
        <section className="asset-main-panel">
          <div className="asset-search-bar">
            <input
              className="asset-search-input"
              placeholder="搜索网站/域名..."
              value={uiState.filters.siteKeyword}
              onChange={(event) =>
                dispatchUI({ type: 'set-site-keyword', value: event.target.value })
              }
              aria-label="搜索网站或域名"
            />
            <button
              className="asset-search-new-folder"
              title="新建文件夹"
              aria-label="新建文件夹"
              onClick={() => setOpenPopover(openPopover === 'folder' ? null : 'folder')}
            >
              <PlusIcon />
            </button>
          </div>

          <div className="filter-chips-row">
            <button
              type="button"
              className={`filter-chip-all${hasActiveFilters ? '' : ' filter-chip-all-active'}`}
              aria-pressed={!hasActiveFilters}
              onClick={resetFilters}
            >
              全部
            </button>

            <FilterChip
              active={folderFilterActive}
              label={folderChipLabel}
              icon="📁"
              expanded={openPopover === 'folder'}
              clearable={folderFilterActive}
              onClick={() => setOpenPopover(openPopover === 'folder' ? null : 'folder')}
              onClear={() => dispatchUI({ type: 'set-folder-filter', value: 'all' })}
            >
              <FilterPopover
                open={openPopover === 'folder'}
                onClose={() => setOpenPopover(null)}
              >
                <ul className="filter-popover-list">
                  <li>
                    <button
                      type="button"
                      className={`filter-popover-option${uiState.filters.folderFilter === 'all' ? ' filter-popover-option-selected' : ''}`}
                      onClick={() => {
                        dispatchUI({ type: 'set-folder-filter', value: 'all' });
                        setOpenPopover(null);
                      }}
                    >
                      <span>全部文件夹</span>
                      <span className="filter-popover-count">{data?.assets.length ?? 0}</span>
                    </button>
                  </li>
                  {data?.folders.map((folder) => (
                    <li key={folder.id}>
                      <button
                        type="button"
                        className={`filter-popover-option${uiState.filters.folderFilter === folder.id ? ' filter-popover-option-selected' : ''}`}
                        onClick={() => {
                          dispatchUI({ type: 'set-folder-filter', value: folder.id });
                          setOpenPopover(null);
                        }}
                      >
                        <span>{folder.name}</span>
                        <span className="filter-popover-count">
                          {assetCountByFolder.get(folder.id) ?? 0}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="filter-popover-create">
                  <input
                    className="filter-popover-create-input"
                    placeholder="新建文件夹名称"
                    value={folderName}
                    onChange={(event) => setFolderName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void createFolder();
                      }
                    }}
                  />
                  <button
                    className="filter-popover-create-btn"
                    onClick={() => void createFolder()}
                    disabled={!folderName.trim()}
                  >
                    创建
                  </button>
                </div>
              </FilterPopover>
            </FilterChip>

            <FilterChip
              active={tagFilterActive}
              label={tagChipLabel}
              icon="🏷"
              expanded={openPopover === 'tag'}
              clearable={tagFilterActive}
              onClick={() => setOpenPopover(openPopover === 'tag' ? null : 'tag')}
              onClear={() => dispatchUI({ type: 'set-tag-filter', value: '' })}
            >
              <FilterPopover open={openPopover === 'tag'} onClose={() => setOpenPopover(null)}>
                {allTags.length === 0 ? (
                  <p className="filter-popover-empty">暂无标签，请在编辑分类时添加。</p>
                ) : (
                  <ul className="filter-popover-list">
                    {allTags.map((tag) => {
                      const selected = selectedTagSet.has(tag);
                      return (
                        <li key={tag}>
                          <button
                            type="button"
                            className={`filter-popover-option${selected ? ' filter-popover-option-selected' : ''}`}
                            onClick={() => toggleTagFilter(tag)}
                          >
                            <span>{tag}</span>
                            <span className="filter-popover-count">{tagCounts.get(tag) ?? 0}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </FilterPopover>
            </FilterChip>

            {hasActiveFilters ? (
              <button
                type="button"
                className="filter-chips-clear"
                onClick={resetFilters}
                aria-label="清空全部筛选"
              >
                清空全部
              </button>
            ) : null}
          </div>

          <div className="media-masonry asset-masonry">
            {filteredAssets.length === 0 ? (
              <div className="empty-state">
                <EmptyImageIcon />
                <p className="empty">{assetsEmptyText}</p>
              </div>
            ) : (
              filteredAssets.map((asset) => {
                const folderNameText =
                  folderNameById[asset.folderId ?? DEFAULT_FOLDER_ID] ??
                  folderNameById[DEFAULT_FOLDER_ID] ??
                  '未分类';
                const card = buildAssetCardViewModel(asset, folderNameText);

                return (
                  <article className="media-card masonry-card" key={asset.id} tabIndex={0}>
                    <div className="media-visual masonry-visual">
                      <AssetThumb asset={asset} />
                    </div>

                    <div className="media-hover-scrim">
                      <div className="media-hover-text">
                        <span className="summary-primary" title={card.summary.primary}>
                          {card.summary.primary}
                        </span>
                        <span className="summary-sep">·</span>
                        <span className="summary-relative">{card.summary.relativeTime}</span>
                        {card.summary.generationBadge ? (
                          <span
                            className="summary-gen-badge"
                            title={card.summary.generationBadge.text}
                            role="button"
                            tabIndex={0}
                            onClick={() => openSidePanel()}
                          >
                            {card.summary.generationBadge.text}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div className="media-hover-actions">
                      <button
                        className="card-action-icon"
                        title="定位文件"
                        aria-label="定位文件"
                        onClick={() => showDownload(asset)}
                      >
                        <FolderIcon />
                      </button>
                      <button
                        className="card-action-icon"
                        title="复制图像"
                        aria-label="复制图像"
                        onClick={() => void copyAsset(asset)}
                      >
                        <CopyIcon />
                      </button>
                      <button
                        className="card-action-icon"
                        title="编辑分类"
                        aria-label="编辑分类"
                        aria-expanded={uiState.editingAssetId === asset.id}
                        onClick={(event: MouseEvent<HTMLButtonElement>) =>
                          enterAssetEdit(asset, event.currentTarget)
                        }
                      >
                        <EditIcon />
                      </button>
                      <button
                        className="card-action-icon"
                        title="AI 生成"
                        aria-label="AI 生成"
                        onClick={() => generateFromAsset(asset)}
                      >
                        <SparkleIcon />
                      </button>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </section>
      ) : null}

      {uiState.view === 'settings' ? (
        <section className="panel settings-panel">
          <div className="panel-head">
            <h2>保存位置设置</h2>
            <span className="hint">托管目录固定为 WYJHExtension</span>
          </div>

          <div className="toolbar">
            <input
              placeholder="下载目录下相对子路径（可留空）"
              value={saveBaseDirDraft}
              onChange={(event) => setSaveBaseDirDraft(event.target.value)}
            />
            <button onClick={() => void updateSaveBaseDir()}>保存位置</button>
          </div>
          <p className="empty">当前托管路径：{managedRootDir}</p>

          <GenerationSettings onNotice={setNotice} />

          <footer className="promo-footer" aria-label="作者联系方式">
            <p className="promo-line">1.联系作者vx进入交流群:Tian_Riching</p>
          </footer>
        </section>
      ) : null}

      {uiState.view === 'help' ? (
        <HelpView
          sections={HELP_SECTIONS}
          onGoSettings={() => dispatchUI({ type: 'switch-view', view: 'settings' })}
        />
      ) : null}

      {uiState.view === 'edit' && editingAsset && editorDraft && editingAssetCard ? (
        <section
          className="panel asset-edit-view"
          aria-labelledby="asset-edit-view-title"
          onKeyDown={handleEditorKeyDown}
        >
          <div className="panel-head">
            <h2 id="asset-edit-view-title">编辑分类</h2>
            <span className="hint">整页编辑，保存后自动返回资产页</span>
          </div>

          <div className="asset-edit-view-body">
            <div className="asset-edit-view-preview-large">
              <AssetThumb asset={editingAsset} />
            </div>

            <p className="asset-edit-view-meta-row">
              <span>{editingAsset.sourceDomain}</span>
              <span>·</span>
              <span>{editingAssetCard.detail.savedAt}</span>
              <span>·</span>
              <span>文件夹：{editingAssetCard.detail.folderName}</span>
            </p>

            <div className="asset-edit-view-fields">
              <label className="asset-edit-view-field">
                <span>文件夹</span>
                <select
                  ref={editorPrimaryFieldRef}
                  value={editorDraft.folderId}
                  onChange={(event) => {
                    setEditorDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            folderId: event.target.value
                          }
                        : prev
                    );
                    setShowDiscardConfirm(false);
                  }}
                >
                  {data?.folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="asset-edit-view-field">
                <span>标签</span>
                <input
                  value={editorDraft.tagText}
                  onChange={(event) => {
                    setEditorDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            tagText: event.target.value
                          }
                        : prev
                    );
                    setShowDiscardConfirm(false);
                  }}
                  placeholder="标签：如 hero, banner"
                />
              </label>
            </div>

            <div className="asset-edit-view-source-section">
              <button
                type="button"
                className="button-secondary source-toggle"
                aria-expanded={isSourceInfoExpanded}
                onClick={() => setIsSourceInfoExpanded((prev) => !prev)}
              >
                {isSourceInfoExpanded ? '收起来源信息' : '展开来源信息'}
              </button>

              <button
                type="button"
                className="button-secondary generate-from-edit"
                onClick={() => editingAsset && generateFromAsset(editingAsset)}
              >
                <SparkleIcon />
                基于此图生成
              </button>

              {isSourceInfoExpanded ? (
                <div className="asset-edit-view-source-panel">
                  <p className="card-detail">
                    <strong>完整来源 URL：</strong>
                    <a href={editingAssetCard.detail.sourcePageUrl} target="_blank" rel="noreferrer">
                      {editingAssetCard.detail.sourcePageUrl}
                    </a>
                  </p>
                  <p className="card-detail">
                    <strong>图片 URL：</strong>
                    {editingAsset?.generatedFrom && !editingAsset.imageUrl.startsWith('data:') ? (
                      // 生成图 imageUrl 为 IndexedDB 字节句柄，不可点击、无外链意义（spec FR-21 第 7 条）
                      <span>IndexedDB 内联（生成图）</span>
                    ) : (
                      <a href={editingAssetCard.detail.imageUrl} target="_blank" rel="noreferrer">
                        {editingAssetCard.detail.imageUrl}
                      </a>
                    )}
                  </p>
                  <p className="card-detail">
                    <strong>当前标签：</strong>
                    {editingAssetCard.detail.tags}
                  </p>
                </div>
              ) : null}
            </div>

            {showDiscardConfirm ? (
              <section
                className="asset-edit-view-discard"
                role="alertdialog"
                aria-label="未保存修改确认"
              >
                <p>你有未保存的修改，确定要放弃吗？</p>
                <div className="asset-edit-view-discard-actions">
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => setShowDiscardConfirm(false)}
                  >
                    继续编辑
                  </button>
                  <button type="button" onClick={leaveAssetEditNow}>
                    放弃修改并返回资产页
                  </button>
                </div>
              </section>
            ) : null}
          </div>

          <footer className="asset-edit-view-footer">
            <button type="button" className="button-secondary" onClick={requestLeaveAssetEdit}>
              取消
            </button>
            <button type="button" onClick={() => void saveAssetEditor()} disabled={!isEditorDirty}>
              保存
            </button>
          </footer>
        </section>
      ) : null}
    </main>
  );
}

export default App;
