import type { KeyboardEvent, ReactNode } from 'react';

interface FilterChipProps {
  /** 是否处于激活/选中态（影响高亮） */
  active: boolean;
  /** chip 文本（如 "文件夹" 或 "设计"） */
  label: string;
  /** chip 前缀图标（可选，如 📁 / 🏷） */
  icon?: ReactNode;
  /** 点击 chip 主体回调（用于切换浮层） */
  onClick: () => void;
  /** 是否展开（aria-expanded） */
  expanded?: boolean;
  /** 是否显示清除按钮 ×（激活时显示） */
  clearable?: boolean;
  /** 清除回调 */
  onClear?: () => void;
  /** 浮层内容（由父组件决定是否渲染 FilterPopover） */
  children?: ReactNode;
}

/**
 * 筛选 chip 组件。
 *
 * 视觉契约：
 * - 默认态：浅色描边、低对比文本。
 * - 激活态：品牌色高亮、回显当前值、右侧出现 × 单清按钮。
 *
 * 交互契约：
 * - 点击 chip 主体 → 切换浮层（onClick）。
 * - 点击 × → 清除该筛选（onClear），不触发浮层。
 * - 键盘：Enter / Space 触发点击；× 按钮独立可聚焦。
 */
export function FilterChip({
  active,
  label,
  icon,
  onClick,
  expanded = false,
  clearable = false,
  onClear,
  children
}: FilterChipProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick();
    }
  }

  return (
    <div className={`filter-chip${active ? ' filter-chip-active' : ''}`}>
      <button
        type="button"
        className="filter-chip-button"
        aria-pressed={active}
        aria-expanded={expanded}
        onClick={onClick}
        onKeyDown={handleKeyDown}
      >
        {icon ? <span className="filter-chip-icon" aria-hidden="true">{icon}</span> : null}
        <span className="filter-chip-label">{label}</span>
        <span className="filter-chip-caret" aria-hidden="true">▾</span>
      </button>

      {active && clearable && onClear ? (
        <button
          type="button"
          className="filter-chip-clear"
          aria-label={`清除 ${label} 筛选`}
          onClick={onClear}
        >
          ×
        </button>
      ) : null}

      {children}
    </div>
  );
}
