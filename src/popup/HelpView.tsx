import { type ReactNode } from 'react';

import type { HelpSection } from './help-content';

interface HelpViewProps {
  sections: HelpSection[];
  onGoSettings: () => void;
}

/** URL 正则：匹配文案中的 http(s) 链接，拆成「纯文本 + 可点击链接」片段。 */
const URL_PATTERN = /(https?:\/\/[^\s。，,]+)/;

/**
 * 把含 URL 的纯文本渲染为「文本 + 外链」片段。
 * 外链统一新开标签页（target="_blank" rel="noreferrer"），与设置页底部 promo 链接行为一致。
 */
function renderDetailWithLinks(detail: string): ReactNode {
  const parts = detail.split(URL_PATTERN);
  return parts.map((part, index) => {
    if (URL_PATTERN.test(part)) {
      return (
        <a key={index} href={part} target="_blank" rel="noreferrer">
          {part}
        </a>
      );
    }
    return part;
  });
}

/**
 * 使用帮助整页视图：渲染教程章节列表 + 步骤序号 + 附录 FAQ。
 * 纯展示组件，不持有状态、不直接 dispatch，跳转由父层传入 onGoSettings 回调。
 */
export function HelpView({ sections, onGoSettings }: HelpViewProps) {
  return (
    <section className="panel help-view" aria-label="使用帮助">
      <div className="help-view-body">
        {sections.map((section) => (
          <section className="help-section" key={section.id} id={section.id}>
            <div className="help-section-head">
              <span className="help-section-icon" aria-hidden="true">{section.icon}</span>
              <h3 className="help-section-title">{section.title}</h3>
            </div>

            {section.intro ? <p className="help-section-intro">{section.intro}</p> : null}

            <ol className="help-steps">
              {section.steps.map((step, index) => (
                <li className="help-step" key={index}>
                  <span className="help-step-num" aria-hidden="true">{index + 1}</span>
                  <div className="help-step-body">
                    <p className="help-step-title">{step.title}</p>
                    <p className="help-step-detail">{renderDetailWithLinks(step.detail)}</p>
                    {step.image ? (
                      <figure className="help-step-figure">
                        <img
                          className="help-step-image"
                          src={step.image.src}
                          alt={step.image.alt}
                          loading="lazy"
                        />
                        {step.image.caption ? (
                          <figcaption className="help-step-caption">{step.image.caption}</figcaption>
                        ) : null}
                      </figure>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>

      <footer className="help-view-footer">
        <button type="button" className="help-go-settings" onClick={onGoSettings}>
          去设置添加服务商与模型
        </button>
      </footer>
    </section>
  );
}
