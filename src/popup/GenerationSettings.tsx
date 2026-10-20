import { useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  createConnection,
  createModel,
  deleteConnection,
  deleteModel,
  loadGenerationConfig,
  replaceConnectionKey,
  updateConnection,
  updateModel,
  type GenerationConfig,
  type GenerationModelRecord,
  type ProviderConnection
} from '../shared/generation-config';
import { getProtocol, listProtocols, type ProtocolId } from '../shared/protocols';
import type { NoticeState } from './view-contract';
import {
  formatAbilitySummary,
  formatBaseUrlHost,
  protocolDefaultLimits,
  validateBaseUrl,
  validateConnectionDraft,
  validateConnectionName,
  validateModelDraft,
  type ConnectionFieldErrors,
  type ModelFieldErrors,
  type ProtocolCapabilities
} from './generation-settings-helpers';

interface GenerationSettingsProps {
  onNotice: (notice: NoticeState) => void;
}

type SettingsScreen = 'list' | 'detail' | 'add-connection' | 'add-model';

type ProtocolDescriptor = ReturnType<typeof listProtocols>[number];

function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function protocolLabel(protocols: ProtocolDescriptor[], protocolId: string): string {
  return protocols.find((protocol) => protocol.id === protocolId)?.label ?? protocolId;
}

function modelLabel(model: GenerationModelRecord): string {
  return model.displayName || model.remoteModelId;
}

/**
 * 设置页「服务商与模型」区（v3.9）。
 *
 * 两级结构全部用组件本地 state 承载（list / detail / add-connection / add-model），
 * 不新增全局视图、不读写明文 Key；写失败由表单内或消息气泡展示中文错误。
 */
export function GenerationSettings({ onNotice }: GenerationSettingsProps) {
  const protocols = useMemo(() => listProtocols(), []);
  const [config, setConfig] = useState<GenerationConfig | null>(null);
  const [screen, setScreen] = useState<SettingsScreen>('list');
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');

  async function refreshConfig(): Promise<GenerationConfig | null> {
    try {
      const next = await loadGenerationConfig();
      setConfig(next);
      setLoadError('');
      return next;
    } catch (error: unknown) {
      setLoadError(readErrorMessage(error, '加载服务商与模型失败，请稍后重试。'));
      return null;
    }
  }

  useEffect(() => {
    void refreshConfig();
  }, []);

  const connections = config?.connections ?? [];
  const models = config?.models ?? [];
  const activeConnection =
    connections.find((connection) => connection.id === activeConnectionId) ?? null;
  const activeModels = activeConnection
    ? models.filter((model) => model.connectionId === activeConnection.id)
    : [];
  const editingModel =
    editingModelId && activeConnection
      ? models.find(
          (model) => model.id === editingModelId && model.connectionId === activeConnection.id
        ) ?? null
      : null;

  const modelCountByConnection = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of models) {
      counts.set(model.connectionId, (counts.get(model.connectionId) ?? 0) + 1);
    }
    return counts;
  }, [models]);

  function goToList(): void {
    setScreen('list');
    setActiveConnectionId(null);
    setEditingModelId(null);
  }

  function openDetail(connectionId: string): void {
    setActiveConnectionId(connectionId);
    setEditingModelId(null);
    setScreen('detail');
  }

  function openAddConnection(): void {
    setEditingModelId(null);
    setScreen('add-connection');
  }

  function openAddModel(): void {
    setEditingModelId(null);
    setScreen('add-model');
  }

  function openEditModel(modelId: string): void {
    setEditingModelId(modelId);
    setScreen('add-model');
  }

  /** 返回按钮逐级回退：添加模型回详情，添加服务商/详情回列表。 */
  function goBack(): void {
    if (screen === 'add-model') {
      setEditingModelId(null);
      setScreen('detail');
      return;
    }
    goToList();
  }

  async function handleConnectionCreated(connectionId: string): Promise<void> {
    const next = await refreshConfig();
    if (!next) {
      return;
    }

    const created = next.connections.find((connection) => connection.id === connectionId) ?? null;
    if (created) {
      onNotice({ type: 'success', message: `服务商「${created.name}」已添加。` });
      setActiveConnectionId(created.id);
      setScreen('detail');
    } else {
      setScreen('list');
    }
  }

  async function handleModelSaved(isEditing: boolean): Promise<void> {
    await refreshConfig();
    setEditingModelId(null);
    setScreen('detail');
    onNotice({ type: 'success', message: isEditing ? '模型已更新。' : '模型已添加。' });
  }

  async function handleConnectionDeleted(connectionName: string): Promise<void> {
    goToList();
    await refreshConfig();
    onNotice({ type: 'success', message: `服务商「${connectionName}」已删除。` });
  }

  const backLabel =
    screen === 'add-model' ? '← 返回服务商详情' : '← 返回服务商列表';

  return (
    <section className="panel generation-settings" aria-label="服务商与模型">
      <div className="panel-head">
        <h2>服务商与模型</h2>
        <span className="hint">软件不内置模型 · 一条服务商一个 Key</span>
      </div>

      {screen !== 'list' ? (
        <button type="button" className="gen-back" onClick={goBack}>
          {backLabel}
        </button>
      ) : null}

      {loadError ? (
        <p className="gen-form-error" role="alert">
          {loadError}
        </p>
      ) : null}

      {screen === 'list' ? (
        <ConnectionList
          connections={connections}
          modelCountByConnection={modelCountByConnection}
          hasAnyModel={models.length > 0}
          onOpen={openDetail}
          onAdd={openAddConnection}
        />
      ) : null}

      {screen === 'add-connection' ? (
        <AddConnectionForm onCancel={goToList} onSaved={handleConnectionCreated} />
      ) : null}

      {screen === 'detail' && activeConnection ? (
        <ConnectionDetail
          connection={activeConnection}
          models={activeModels}
          protocols={protocols}
          onConfigChanged={refreshConfig}
          onDeleted={handleConnectionDeleted}
          onAddModel={openAddModel}
          onEditModel={openEditModel}
          onNotice={onNotice}
        />
      ) : null}

      {screen === 'detail' && !activeConnection ? (
        <p className="gen-empty-line">该服务商不存在或已被删除。</p>
      ) : null}

      {screen === 'add-model' && activeConnection ? (
        <ModelForm
          connection={activeConnection}
          protocols={protocols}
          initialModel={editingModel}
          onCancel={goBack}
          onSaved={handleModelSaved}
        />
      ) : null}

      {screen === 'add-model' && !activeConnection ? (
        <p className="gen-empty-line">该服务商不存在或已被删除。</p>
      ) : null}
    </section>
  );
}

function ConnectionList({
  connections,
  modelCountByConnection,
  hasAnyModel,
  onOpen,
  onAdd
}: {
  connections: ProviderConnection[];
  modelCountByConnection: Map<string, number>;
  hasAnyModel: boolean;
  onOpen: (connectionId: string) => void;
  onAdd: () => void;
}) {
  if (connections.length === 0) {
    return (
      <>
        <div className="gen-empty" role="status">
          <p>软件不内置模型，先添加服务商与模型。</p>
          <p className="gen-hint">添加服务商后，在服务商下添加模型即可在侧边栏生成。</p>
        </div>
        <div className="gen-actions">
          <button type="button" onClick={onAdd}>
            + 添加服务商
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="gen-table-wrap">
        <table className="gen-table">
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">主机名</th>
              <th scope="col">模型数</th>
              <th scope="col">Key 状态</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {connections.map((connection) => {
              const modelCount = modelCountByConnection.get(connection.id) ?? 0;
              return (
                <tr key={connection.id}>
                  <td className="gen-strong">{connection.name}</td>
                  <td className="gen-host" title={connection.baseUrl}>
                    {formatBaseUrlHost(connection.baseUrl)}
                  </td>
                  <td>{modelCount}</td>
                  <td>
                    <span className={`gen-key-status${connection.hasKey ? ' is-saved' : ''}`}>
                      {connection.hasKey ? '已保存' : '未保存'}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="gen-link-button"
                      aria-label={`查看服务商 ${connection.name}`}
                      onClick={() => onOpen(connection.id)}
                    >
                      详情 →
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="gen-actions">
        <button type="button" onClick={onAdd}>
          + 添加服务商
        </button>
      </div>

      {!hasAnyModel ? (
        <p className="gen-hint">已有服务商，但还没有模型。进入服务商详情点「添加模型」。</p>
      ) : null}
    </>
  );
}

function AddConnectionForm({
  onCancel,
  onSaved
}: {
  onCancel: () => void;
  onSaved: (connectionId: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [errors, setErrors] = useState<ConnectionFieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const validation = validateConnectionDraft({ name, baseUrl, apiKey });
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      const created = await createConnection({
        ...(validation.value.name ? { name: validation.value.name } : {}),
        baseUrl: validation.value.baseUrl,
        apiKey: validation.value.apiKey
      });
      setApiKey('');
      await onSaved(created.id);
    } catch (error: unknown) {
      setErrors({ form: readErrorMessage(error, '添加服务商失败，请稍后重试。') });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="gen-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
      <div className="gen-form-head">
        <h3>添加服务商</h3>
        <p className="gen-hint">一条服务商对应一个地址与一个 Key，其下模型共用这个 Key。</p>
      </div>

      <label className="gen-field">
        <span>名称（可留空，按主机名生成）</span>
        <input
          value={name}
          maxLength={40}
          onChange={(event) => {
            setName(event.target.value);
            setErrors((prev) => ({ ...prev, name: undefined }));
          }}
          placeholder="如：我的中转站"
          aria-label="服务商名称（可留空）"
        />
        {errors.name ? <span className="gen-field-error">{errors.name}</span> : null}
      </label>

      <label className="gen-field">
        <span>Base URL</span>
        <input
          value={baseUrl}
          onChange={(event) => {
            setBaseUrl(event.target.value);
            setErrors((prev) => ({ ...prev, baseUrl: undefined }));
          }}
          placeholder="https://api.example.com/v1"
          aria-label="服务商 Base URL"
        />
        <span className="gen-field-hint">地址通常以 /v1 或 /v1beta 结尾；软件不自动补版本段，也不去重。</span>
        {errors.baseUrl ? <span className="gen-field-error">{errors.baseUrl}</span> : null}
      </label>

      <label className="gen-field">
        <span>API Key</span>
        <input
          type="password"
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            setErrors((prev) => ({ ...prev, apiKey: undefined }));
          }}
          placeholder="粘贴服务商提供的 API Key"
          aria-label="服务商 API Key"
          autoComplete="new-password"
        />
        <span className="gen-field-hint">只保存不验证；Key 仅在首次生图请求时由远端反馈是否有效。</span>
        {errors.apiKey ? <span className="gen-field-error">{errors.apiKey}</span> : null}
      </label>

      {errors.form ? (
        <p className="gen-form-error" role="alert">
          {errors.form}
        </p>
      ) : null}

      <div className="gen-form-actions">
        <button type="button" className="button-secondary" onClick={onCancel} disabled={submitting}>
          取消
        </button>
        <button type="submit" disabled={submitting}>
          {submitting ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}

function ConnectionDetail({
  connection,
  models,
  protocols,
  onConfigChanged,
  onDeleted,
  onAddModel,
  onEditModel,
  onNotice
}: {
  connection: ProviderConnection;
  models: GenerationModelRecord[];
  protocols: ProtocolDescriptor[];
  onConfigChanged: () => Promise<GenerationConfig | null>;
  onDeleted: (connectionName: string) => Promise<void>;
  onAddModel: () => void;
  onEditModel: (modelId: string) => void;
  onNotice: (notice: NoticeState) => void;
}) {
  const [name, setName] = useState(connection.name);
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl);
  const [nameError, setNameError] = useState('');
  const [baseUrlError, setBaseUrlError] = useState('');
  const [actionError, setActionError] = useState('');
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyError, setKeyError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(connection.name);
    setBaseUrl(connection.baseUrl);
    setNameError('');
    setBaseUrlError('');
    setActionError('');
    setKeyOpen(false);
    setKeyDraft('');
    setKeyError('');
  }, [connection.id, connection.name, connection.baseUrl, connection.hasKey]);

  async function saveName(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('名称不能为空。');
      return;
    }
    const validationError = validateConnectionName(name);
    if (validationError) {
      setNameError(validationError);
      return;
    }

    setBusy(true);
    try {
      await updateConnection(connection.id, { name: trimmed });
      setNameError('');
      onNotice({ type: 'success', message: '服务商名称已更新。' });
      await onConfigChanged();
    } catch (error: unknown) {
      setNameError(readErrorMessage(error, '保存服务商名称失败。'));
    } finally {
      setBusy(false);
    }
  }

  async function saveBaseUrl(): Promise<void> {
    const validation = validateBaseUrl(baseUrl);
    if (!validation.ok) {
      setBaseUrlError(validation.error);
      return;
    }

    setBusy(true);
    try {
      await updateConnection(connection.id, { baseUrl: validation.value });
      setBaseUrl(validation.value);
      setBaseUrlError('');
      onNotice({ type: 'success', message: 'Base URL 已更新。' });
      await onConfigChanged();
    } catch (error: unknown) {
      setBaseUrlError(readErrorMessage(error, '保存 Base URL 失败。'));
    } finally {
      setBusy(false);
    }
  }

  async function saveKey(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextKey = keyDraft.trim();
    if (!nextKey) {
      setKeyError('请填写新的 API Key。');
      return;
    }

    setBusy(true);
    try {
      await replaceConnectionKey(connection.id, nextKey);
      setKeyDraft('');
      setKeyError('');
      setKeyOpen(false);
      onNotice({ type: 'success', message: 'API Key 已更新，后续请求将使用新 Key。' });
      await onConfigChanged();
    } catch (error: unknown) {
      setKeyError(readErrorMessage(error, '更换 API Key 失败。'));
    } finally {
      setBusy(false);
    }
  }

  async function removeConnection(): Promise<void> {
    const confirmed = window.confirm(
      `确定删除服务商「${connection.name}」吗？该服务商下的 ${models.length} 个模型会一并删除，且无法恢复。`
    );
    if (!confirmed) {
      return;
    }

    setBusy(true);
    try {
      await deleteConnection(connection.id);
      await onDeleted(connection.name);
    } catch (error: unknown) {
      setActionError(readErrorMessage(error, '删除服务商失败。'));
    } finally {
      setBusy(false);
    }
  }

  async function removeModel(model: GenerationModelRecord): Promise<void> {
    const confirmed = window.confirm(
      `确定删除模型「${modelLabel(model)}」吗？删除后无法恢复，历史生成资产不受影响。`
    );
    if (!confirmed) {
      return;
    }

    setBusy(true);
    try {
      await deleteModel(model.id);
      onNotice({ type: 'success', message: `模型「${modelLabel(model)}」已删除。` });
      await onConfigChanged();
    } catch (error: unknown) {
      setActionError(readErrorMessage(error, '删除模型失败。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="gen-detail-fields">
        <div className="gen-inline-field">
          <label>
            <span>名称</span>
            <input
              value={name}
              maxLength={40}
              onChange={(event) => {
                setName(event.target.value);
                setNameError('');
              }}
              aria-label="编辑服务商名称"
            />
          </label>
          <button
            type="button"
            onClick={() => void saveName()}
            disabled={busy}
            aria-label="保存服务商名称"
          >
            保存
          </button>
        </div>
        {nameError ? <p className="gen-field-error">{nameError}</p> : null}

        <div className="gen-inline-field">
          <label>
            <span>Base URL</span>
            <input
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                setBaseUrlError('');
              }}
              aria-label="编辑服务商 Base URL"
            />
          </label>
          <button
            type="button"
            onClick={() => void saveBaseUrl()}
            disabled={busy}
            aria-label="保存服务商 Base URL"
          >
            保存
          </button>
        </div>
        <p className="gen-field-hint">地址通常以 /v1 或 /v1beta 结尾；修改只影响之后的请求。</p>
        {baseUrlError ? <p className="gen-field-error">{baseUrlError}</p> : null}
      </div>

      <div className="gen-key-row">
        <span>
          Key：<strong>{connection.hasKey ? '已保存' : '未保存'}</strong>
        </span>
        <button
          type="button"
          className="button-secondary gen-small-button"
          onClick={() => {
            if (keyOpen) {
              setKeyDraft('');
            }
            setKeyOpen((prev) => !prev);
            setKeyError('');
          }}
          aria-expanded={keyOpen}
        >
          {keyOpen ? '取消更换' : '更换 Key'}
        </button>
      </div>

      {keyOpen ? (
        <form className="gen-key-form" onSubmit={(event) => void saveKey(event)} noValidate>
          <label className="gen-field">
            <span>新的 API Key（只保存，不回显）</span>
            <input
              type="password"
              value={keyDraft}
              onChange={(event) => {
                setKeyDraft(event.target.value);
                setKeyError('');
              }}
              placeholder="粘贴新的 API Key"
              aria-label="新的服务商 API Key"
              autoComplete="new-password"
            />
          </label>
          {keyError ? <p className="gen-field-error">{keyError}</p> : null}
          <div className="gen-form-actions">
            <button type="submit" disabled={busy}>
              {busy ? '保存中…' : '保存新 Key'}
            </button>
          </div>
        </form>
      ) : null}

      <div className="gen-danger-row">
        <button
          type="button"
          className="gen-danger-button"
          onClick={() => void removeConnection()}
          disabled={busy}
        >
          删除服务商
        </button>
      </div>

      {actionError ? (
        <p className="gen-form-error" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="gen-models-head">
        <h3>模型（{models.length}）</h3>
      </div>

      {models.length === 0 ? (
        <p className="gen-empty-line">还没有模型，点「添加模型」创建第一条记录。</p>
      ) : (
        <div className="gen-table-wrap">
          <table className="gen-table gen-model-table">
            <thead>
              <tr>
                <th scope="col">模型</th>
                <th scope="col">远端型号</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr key={model.id}>
                  <td className="gen-strong">
                    <div>{modelLabel(model)}</div>
                    <div className="gen-model-sub">
                      {protocolLabel(protocols, model.protocolId)} · {formatAbilitySummary(model)}
                    </div>
                  </td>
                  <td className="gen-host" title={model.remoteModelId}>
                    {model.remoteModelId}
                  </td>
                  <td>
                    <div className="gen-row-actions">
                      <button
                        type="button"
                        className="gen-link-button"
                        onClick={() => onEditModel(model.id)}
                        aria-label={`编辑模型 ${modelLabel(model)}`}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="gen-link-button gen-danger-link"
                        onClick={() => void removeModel(model)}
                        disabled={busy}
                        aria-label={`删除模型 ${modelLabel(model)}`}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="gen-actions">
        <button type="button" onClick={onAddModel} disabled={busy}>
          + 添加模型
        </button>
      </div>
    </>
  );
}

function ModelForm({
  connection,
  protocols,
  initialModel,
  onCancel,
  onSaved
}: {
  connection: ProviderConnection;
  protocols: ProtocolDescriptor[];
  initialModel: GenerationModelRecord | null;
  onCancel: () => void;
  onSaved: (isEditing: boolean) => Promise<void>;
}) {
  const isEditing = Boolean(initialModel);
  const initialProtocol = initialModel ? getProtocol(initialModel.protocolId) : null;

  const [protocolId, setProtocolId] = useState(initialModel?.protocolId ?? '');
  const [remoteModelId, setRemoteModelId] = useState(initialModel?.remoteModelId ?? '');
  const [displayName, setDisplayName] = useState(initialModel?.displayName ?? '');
  const [supportsReferenceImage, setSupportsReferenceImage] = useState(
    initialModel?.supportsReferenceImage ?? true
  );
  const [maxRefs, setMaxRefs] = useState(
    initialModel
      ? String(initialModel.maxRefs)
      : initialProtocol
        ? String(initialProtocol.params.maxRefs)
        : ''
  );
  const [maxN, setMaxN] = useState(
    initialModel
      ? String(initialModel.maxN)
      : initialProtocol
        ? String(initialProtocol.params.maxN)
        : ''
  );
  const [errors, setErrors] = useState<ModelFieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const capabilities: ProtocolCapabilities | null = protocolId
    ? getProtocol(protocolId as ProtocolId)?.params ?? null
    : null;

  function handleProtocolChange(nextProtocolId: string): void {
    setProtocolId(nextProtocolId);
    setErrors((prev) => ({ ...prev, protocolId: undefined, maxRefs: undefined, maxN: undefined }));

    if (!nextProtocolId) {
      setMaxRefs('');
      setMaxN('');
      return;
    }

    const protocol = getProtocol(nextProtocolId as ProtocolId);
    if (!protocol) {
      setMaxRefs('');
      setMaxN('');
      return;
    }

    const defaults = protocolDefaultLimits(protocol.params);
    setSupportsReferenceImage(true);
    setMaxRefs(defaults.maxRefs);
    setMaxN(defaults.maxN);
  }

  function toggleReferenceImage(next: boolean): void {
    setSupportsReferenceImage(next);
    if (!next) {
      setMaxRefs('0');
    } else if (Number(maxRefs) === 0) {
      setMaxRefs(capabilities ? String(capabilities.maxRefs) : '');
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const validation = validateModelDraft(
      {
        protocolId,
        remoteModelId,
        displayName,
        supportsReferenceImage,
        maxRefs,
        maxN
      },
      capabilities
    );
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      if (initialModel) {
        await updateModel(initialModel.id, {
          remoteModelId: validation.value.remoteModelId,
          displayName: validation.value.displayName ?? validation.value.remoteModelId,
          supportsReferenceImage: validation.value.supportsReferenceImage,
          maxRefs: validation.value.maxRefs,
          maxN: validation.value.maxN
        });
      } else {
        await createModel({
          connectionId: connection.id,
          protocolId: validation.value.protocolId as ProtocolId,
          remoteModelId: validation.value.remoteModelId,
          ...(validation.value.displayName ? { displayName: validation.value.displayName } : {}),
          supportsReferenceImage: validation.value.supportsReferenceImage,
          maxRefs: validation.value.maxRefs,
          maxN: validation.value.maxN
        });
      }
      await onSaved(isEditing);
    } catch (error: unknown) {
      setErrors({ form: readErrorMessage(error, isEditing ? '更新模型失败。' : '添加模型失败。') });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="gen-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
      <div className="gen-form-head">
        <h3>{isEditing ? '编辑模型' : '添加模型'}</h3>
        <p className="gen-hint">所属服务商：{connection.name}</p>
      </div>

      <label className="gen-field">
        <span>接口类型</span>
        <select
          value={protocolId}
          onChange={(event) => handleProtocolChange(event.target.value)}
          disabled={isEditing}
          aria-label="模型接口类型"
        >
          <option value="">请选择接口类型</option>
          {protocols.map((protocol) => (
            <option key={protocol.id} value={protocol.id}>
              {protocol.label}
            </option>
          ))}
        </select>
        <span className="gen-field-hint">
          {isEditing
            ? '接口类型与所属服务商创建后不可修改；需要更换请删除后重新添加。'
            : '接口类型由软件内置，创建后不可修改。'}
        </span>
        {errors.protocolId ? <span className="gen-field-error">{errors.protocolId}</span> : null}
      </label>

      <label className="gen-field">
        <span>远端模型 ID</span>
        <input
          value={remoteModelId}
          maxLength={128}
          onChange={(event) => {
            setRemoteModelId(event.target.value);
            setErrors((prev) => ({ ...prev, remoteModelId: undefined }));
          }}
          placeholder="如：gpt-image-2"
          aria-label="远端模型 ID"
        />
        <span className="gen-field-hint">填服务商文档里的型号，会原样用于请求地址或请求体。</span>
        {errors.remoteModelId ? (
          <span className="gen-field-error">{errors.remoteModelId}</span>
        ) : null}
      </label>

      <label className="gen-field">
        <span>显示名（可留空，默认取远端模型 ID）</span>
        <input
          value={displayName}
          maxLength={60}
          onChange={(event) => {
            setDisplayName(event.target.value);
            setErrors((prev) => ({ ...prev, displayName: undefined }));
          }}
          placeholder="侧边栏模型下拉里显示的名字"
          aria-label="模型显示名（可留空）"
        />
        {errors.displayName ? (
          <span className="gen-field-error">{errors.displayName}</span>
        ) : null}
      </label>

      <label className="gen-checkbox">
        <input
          type="checkbox"
          checked={supportsReferenceImage}
          onChange={(event) => toggleReferenceImage(event.target.checked)}
          aria-label="该模型支持参考图"
        />
        <span>支持参考图（图生图）</span>
      </label>

      <div className="gen-capability-row">
        <label className="gen-field">
          <span>参考图上限</span>
          <input
            type="number"
            min={0}
            max={capabilities?.maxRefs}
            value={supportsReferenceImage ? maxRefs : '0'}
            onChange={(event) => {
              setMaxRefs(event.target.value);
              setErrors((prev) => ({ ...prev, maxRefs: undefined }));
            }}
            disabled={!supportsReferenceImage || !capabilities}
            aria-label="参考图上限"
          />
          <span className="gen-field-hint">
            {capabilities ? `最多 ${capabilities.maxRefs} 张` : '选择接口类型后可用'}
          </span>
          {errors.maxRefs ? <span className="gen-field-error">{errors.maxRefs}</span> : null}
        </label>

        <label className="gen-field">
          <span>单次数量上限</span>
          <input
            type="number"
            min={1}
            max={capabilities?.maxN}
            value={maxN}
            onChange={(event) => {
              setMaxN(event.target.value);
              setErrors((prev) => ({ ...prev, maxN: undefined }));
            }}
            disabled={!capabilities}
            aria-label="单次数量上限"
          />
          <span className="gen-field-hint">
            {capabilities ? `最多 ${capabilities.maxN} 张` : '选择接口类型后可用'}
          </span>
          {errors.maxN ? <span className="gen-field-error">{errors.maxN}</span> : null}
        </label>
      </div>

      <p className="gen-field-hint">切换接口类型时，能力字段会按该类型的上限重置。</p>

      {errors.form ? (
        <p className="gen-form-error" role="alert">
          {errors.form}
        </p>
      ) : null}

      <div className="gen-form-actions">
        <button type="button" className="button-secondary" onClick={onCancel} disabled={submitting}>
          取消
        </button>
        <button type="submit" disabled={submitting}>
          {submitting ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}
