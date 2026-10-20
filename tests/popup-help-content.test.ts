import { describe, expect, it } from 'vitest';

import { HELP_LINKS, HELP_SECTIONS } from '../src/popup/help-content';

const CORE_STEP_IDS = ['get-key', 'add-connection', 'add-model', 'generate'];

function allDetailText(): string {
  return HELP_SECTIONS.flatMap((section) => [
    section.title,
    ...(section.intro ? [section.intro] : []),
    ...section.steps.flatMap((step) => [step.title, step.detail])
  ]).join('\n');
}

describe('help content', () => {
  it('教程非空且每节结构完整（id/title/steps 齐全、步骤 detail 非空）', () => {
    expect(HELP_SECTIONS.length).toBeGreaterThan(0);

    for (const section of HELP_SECTIONS) {
      expect(section.id.trim().length).toBeGreaterThan(0);
      expect(section.title.trim().length).toBeGreaterThan(0);
      expect(section.steps.length).toBeGreaterThan(0);

      for (const step of section.steps) {
        expect(step.title.trim().length).toBeGreaterThan(0);
        expect(step.detail.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('章节 id 唯一（锚点稳定性）', () => {
    const ids = HELP_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('v3.9：教程为通用四步——获取 Key → 添加服务商 → 添加模型 → 回侧边栏生成', () => {
    const coreSections = HELP_SECTIONS.filter((section) => CORE_STEP_IDS.includes(section.id));
    expect(coreSections.map((section) => section.id)).toEqual(CORE_STEP_IDS);

    const titles = coreSections.map((section) => section.title);
    expect(titles[0]).toMatch(/获取 API Key/);
    expect(titles[1]).toMatch(/添加服务商/);
    expect(titles[2]).toMatch(/添加模型/);
    expect(titles[3]).toMatch(/回侧边栏生成/);
  });

  it('不再以「注册账号 / 充值余额 / 固定站点」为教程主步骤', () => {
    const coreTitles = HELP_SECTIONS.filter((section) =>
      CORE_STEP_IDS.includes(section.id)
    ).map((section) => section.title);

    expect(coreTitles.some((title) => /注册账号/.test(title))).toBe(false);
    expect(coreTitles.some((title) => /充值余额/.test(title))).toBe(false);
    expect(allDetailText()).not.toMatch(/API 站点固定为|站点固定为|固定 API 站|唯一的接入地址/);
  });

  it('示例站点只以「示例」身份出现，并明确不是唯一 / 固定地址', () => {
    expect(HELP_LINKS.exampleSite).toContain('www.wyjh.top');

    const detailText = allDetailText();
    const paragraphs = detailText.split('\n').filter((line) => /wyjh\.top/.test(line));
    expect(paragraphs.length).toBeGreaterThan(0);

    for (const paragraph of paragraphs) {
      expect(paragraph).toMatch(/示例/);
      expect(paragraph).toMatch(/不是唯一|仅作示例|不代表唯一/);
    }
  });

  it('FAQ 覆盖 Key 存储、模型来源与「每连接一个 Key」', () => {
    const faq = HELP_SECTIONS.find((section) => section.id === 'faq');
    expect(faq).toBeTruthy();

    const faqText = faq?.steps.map((step) => `${step.title}：${step.detail}`).join('\n') ?? '';
    expect(faqText).toMatch(/Key 存在哪里/);
    expect(faqText).toMatch(/模型由你添加/);
    expect(faqText).toMatch(/一条服务商连接只填一个 Key/);
  });
});
