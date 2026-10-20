import { describe, expect, it } from 'vitest';

import appSource from '../src/popup/App.tsx?raw';
import generationSettingsSource from '../src/popup/GenerationSettings.tsx?raw';

describe('popup promo footer (v2.0 / v3.9)', () => {
  it('保留作者联系方式，不再出现固定 API 站表述', () => {
    expect(appSource).toContain('className="promo-footer"');
    expect(appSource).toContain('Tian_Riching');
    expect(appSource).not.toContain('API站');
    expect(appSource).not.toContain('API 站点');
    expect(appSource).not.toContain('wyjh.top');
  });

  it('v2.0：促销 footer 归属设置页，位于 settingsPanel 内（资产浏览区不出现）', () => {
    const settingsPanelIndex = appSource.indexOf('className="panel settings-panel"');
    const footerIndex = appSource.indexOf('className="promo-footer"');

    expect(settingsPanelIndex).toBeGreaterThan(-1);
    expect(footerIndex).toBeGreaterThan(settingsPanelIndex);
  });

  it('v2.0：资产 masonry 网格与促销 footer 不在同一段（footer 不在资产浏览区）', () => {
    const masonryIndex = appSource.indexOf('className="media-masonry asset-masonry"');
    const footerIndex = appSource.indexOf('className="promo-footer"');
    const settingsPanelIndex = appSource.indexOf('className="panel settings-panel"');

    expect(masonryIndex).toBeGreaterThan(-1);
    expect(settingsPanelIndex).toBeGreaterThan(masonryIndex);
    expect(footerIndex).toBeGreaterThan(settingsPanelIndex);
  });

  it('v3.9：设置页以「服务商与模型」替换旧「生图 API」配置区', () => {
    const settingsPanelIndex = appSource.indexOf('className="panel settings-panel"');
    const generationSettingsIndex = appSource.indexOf('<GenerationSettings');
    const footerIndex = appSource.indexOf('className="promo-footer"');

    expect(generationSettingsIndex).toBeGreaterThan(settingsPanelIndex);
    expect(footerIndex).toBeGreaterThan(generationSettingsIndex);
    expect(appSource).not.toContain('className="panel api-config-panel"');
    expect(appSource).not.toContain('api-key-mode');
    expect(appSource).not.toContain('per-model');
  });

  it('v3.9：设置区文案使用业务语言，且不出现内部类型名', () => {
    expect(generationSettingsSource).toContain('服务商与模型');
    expect(generationSettingsSource).toContain('添加服务商');
    expect(generationSettingsSource).toContain('软件不内置模型');
    expect(generationSettingsSource).toContain('更换 Key');
    expect(generationSettingsSource).toContain('删除服务商');
    expect(generationSettingsSource).toContain('接口类型');
    expect(generationSettingsSource).toContain('远端模型 ID');
    expect(generationSettingsSource).not.toMatch(/>\s*(ProviderConnection|ProtocolAdapter)\s*</);
  });
});
