/**
 * 使用帮助教程数据（纯数据，可单测）。
 *
 * 承载形式：结构化章节数组，由 HelpView 渲染。不引入 Markdown / 外部依赖。
 * v3.9：教程改为通用四步——获取 API Key → 添加服务商 → 添加模型 → 回侧边栏生成。
 * `www.wyjh.top` 仅作为「示例站点」出现，不是唯一或固定的接入地址。
 */

/** 单步操作：标题 + 说明 + 可选配图。说明为纯文本，可含外链 URL（HelpView 识别 http(s):// 并渲染为可点击链接）。 */
export interface HelpStep {
  title: string;
  detail: string;
  /** 配图 URL（Vite 处理后的 import）。caption 为配图下方说明。 */
  image?: { src: string; alt: string; caption?: string };
}

/** 章节：图标 + 标题 + 引言（可选）+ 有序步骤。附录 FAQ 复用本结构（title=问、detail=答）。 */
export interface HelpSection {
  id: string;
  icon: string;
  title: string;
  intro?: string;
  steps: HelpStep[];
}

/** 示例站点地址（集中管理，避免文案散落多处导致后续漂移）。仅用于示例，不参与请求。 */
export const HELP_LINKS = {
  exampleSite: 'https://www.wyjh.top'
} as const;

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'get-key',
    icon: '🔑',
    title: '1. 获取 API Key',
    intro: '在你要使用的生图服务商处注册 / 登录，创建并复制 API Key；Key 通常只完整显示一次。',
    steps: [
      {
        title: '打开服务商控制台',
        detail: `登录你所选服务商的控制台，进入「API Key / 令牌管理」类页面。不同服务商入口不同；示例站点 ${HELP_LINKS.exampleSite} 仅作示例，不是唯一或固定地址。`
      },
      {
        title: '创建并复制 Key',
        detail:
          '新建一个 Key（有的服务商叫令牌），名称可随意填写；创建后立即复制保存。关闭页面后通常只能看到掩码，无法再查看完整值。'
      }
    ]
  },
  {
    id: 'add-connection',
    icon: '🏠',
    title: '2. 添加服务商',
    intro: '在设置页登记服务商地址与 Key；一条服务商对应一个 Base URL 与一个 Key。',
    steps: [
      {
        title: '打开插件设置',
        detail: '点击弹窗顶栏的「设置」，找到「服务商与模型」，点击「添加服务商」。'
      },
      {
        title: '填写表单',
        detail:
          '名称可留空，保存时按主机名生成。Base URL 是含版本路径的 API 根，例如 https://host/v1 或 https://host/v1beta；软件不自动补版本段，也不去重。粘贴第 1 步复制的 Key 后保存。'
      }
    ]
  },
  {
    id: 'add-model',
    icon: '🧩',
    title: '3. 添加模型',
    intro: '模型清单由你自己维护，软件不内置模型。',
    steps: [
      {
        title: '进入服务商详情',
        detail: '在服务商列表点击刚添加的服务商，进入详情后点「添加模型」。'
      },
      {
        title: '选择接口类型',
        detail:
          '接口类型决定请求格式（如 OpenAI Images 或 Gemini Image），由软件内置，创建后不可修改；需要更换时删除模型后重新添加。'
      },
      {
        title: '填写远端模型 ID 与显示名',
        detail:
          '远端模型 ID 填服务商文档里的型号（如 gpt-image-2）；显示名可留空，默认取远端模型 ID，也是侧边栏下拉里展示的名字。'
      },
      {
        title: '声明能力',
        detail:
          '按模型实际能力勾选「支持参考图」，再设置参考图上限与单次数量上限；两项都不能超过接口类型允许的最大值。'
      }
    ]
  },
  {
    id: 'generate',
    icon: '✨',
    title: '4. 回侧边栏生成',
    intro: '打开侧边栏，选择刚添加的模型即可开始生成。',
    steps: [
      {
        title: '打开侧边栏',
        detail: '点击弹窗顶栏的「生图」，或在扩展侧边栏中新建任务。'
      },
      {
        title: '选择模型并填写内容',
        detail:
          '在任务参数区顶部下拉选择模型（按服务商分组）；文生图直接填 prompt，图生图先添加参考图。'
      },
      {
        title: '生成',
        detail: '点击「生成」，生成结果会自动保存到资产库。'
      }
    ]
  },
  {
    id: 'faq',
    icon: '❓',
    title: '常见问题',
    steps: [
      {
        title: 'Key 存在哪里？安全吗？',
        detail:
          'Key 按服务商保存在浏览器本地，仅由插件后台读取并用于向你配置的服务商发请求；不会上传给插件作者，也不会写入日志或消息内容。设置页只写入新 Key，不回显明文。'
      },
      {
        title: '支持哪些模型？怎么切换？',
        detail:
          '模型由你添加，软件不内置模型；能接入哪些模型取决于你的服务商。侧边栏模型下拉按服务商分组，每个任务都可以单独切换。'
      },
      {
        title: '每个模型要单独填 Key 吗？',
        detail: '不用。一条服务商连接只填一个 Key，该服务商下的所有模型共用这个 Key。'
      },
      {
        title: 'Base URL 末尾要不要带 /v1？',
        detail:
          '要看你所用服务商的要求，地址通常以 /v1 或 /v1beta 结尾。软件会原样保留你填写的版本路径，不自动补、也不去重；填错时首次生成会收到远端的 404 等错误。'
      },
      {
        title: 'Key 失效或充值没到账怎么办？',
        detail:
          'Key、余额、充值等账号问题请联系对应服务商处理。示例站点 www.wyjh.top 仅作示例，不代表唯一的服务地址。'
      }
    ]
  }
];
