import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: '素材采图',
  description: '保存网页图片到本地资产库，并用自带 API Key 的 AI 服务做图生图与多图收集。',
  version: '0.2.0',
  action: {
    default_title: '素材采图',
    default_popup: 'src/popup/index.html'
  },
  permissions: ['storage', 'downloads', 'tabs', 'activeTab', 'clipboardWrite', 'contextMenus', 'sidePanel'],
  host_permissions: ['<all_urls>'],
  side_panel: {
    default_path: 'src/sidepanel/index.html'
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module'
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: true,
      match_about_blank: true
    }
  ]
});
