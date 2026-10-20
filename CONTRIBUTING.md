# Contributing

欢迎提交 Issue 和 Pull Request。

## 开发环境

- Node.js 20+
- `npm install`
- `npm run dev` 启动 Vite 开发服务器

## 提交前自检

```bash
npm run lint
npm test
npm run build
```

三项必须全部通过。新增行为请补充对应测试。

## 代码约定

- TypeScript strict 模式，不引入 `any` 逃逸（项目已关闭 `no-explicit-any` 规则，但仍应避免）
- 资产库唯一写入方是 background；popup 与 sidepanel 只读
- 保存入口只有两种：右键菜单与图片角标，复用同一条保存链路
- 不新增第二套状态机、消息协议或术语；改契约前先开 Issue 对齐
- 不提交 `dist/`、`node_modules/`、zip 产物

## Pull Request

- 先开 Issue 描述问题或需求，较大改动先对齐范围
- 一个 PR 只做一件事，附带复现步骤与验证方式
- 提交信息用中文或英文均可，保持祈使句

## 设计文档

产品需求、设计文档与 agent 记忆由维护者私有维护，不随本仓库发布。涉及较大改动时，请在 Issue 中先对齐设计口径，再提 PR。
