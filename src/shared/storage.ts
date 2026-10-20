import { createDefaultData, ExtensionData, STORAGE_KEY } from './model';

/** 资产主数据结构存储键（生图配置使用 generation-config.ts 的独立四键，不混入资产库）。 */
export const STORAGE_KEYS = {
  assets: STORAGE_KEY
} as const;

export async function loadExtensionData(): Promise<ExtensionData> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const data = result[STORAGE_KEY] as ExtensionData | undefined;
  const defaultData = createDefaultData();

  if (!data) {
    const initialData = createDefaultData();
    await saveExtensionData(initialData);
    return initialData;
  }

  return {
    ...defaultData,
    ...data,
    settings: {
      ...defaultData.settings,
      ...data.settings
    },
    folders: data.folders?.length ? data.folders : defaultData.folders,
    assets: data.assets ?? []
  };
}

export async function saveExtensionData(data: ExtensionData): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEY]: data
  });
}

export async function mutateExtensionData(
  updater: (data: ExtensionData) => ExtensionData
): Promise<ExtensionData> {
  const data = await loadExtensionData();
  const next = updater(data);
  await saveExtensionData(next);
  return next;
}
