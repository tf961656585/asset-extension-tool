import { useEffect, useRef, type ReactNode } from 'react';

interface FilterPopoverProps {
  /** 是否展开 */
  open: boolean;
  /** 关闭回调（外部点击或 ESC 触发） */
  onClose: () => void;
  /** 浮层内容 */
  children: ReactNode;
}

/**
 * 筛选 chip 通用下拉浮层。
 *
 * 行为契约：
 * - 外部点击（mousedown）关闭浮层。
 * - 按 ESC 关闭浮层。
 * - 关闭由父组件通过 onClose 驱动（受控），便于实现「同一时刻只允许一个浮层打开」。
 *
 * 不负责定位算法：父组件用相对定位容器，本组件以 absolute 定位在触发器下方。
 * 浮层自身约束 max-width 并在右边界场景靠右对齐（由 CSS 控制）。
 */
export function FilterPopover({ open, onClose, children }: FilterPopoverProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent): void {
      const container = containerRef.current;
      if (container && !container.contains(event.target as Node)) {
        onClose();
      }
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="filter-popover" ref={containerRef} role="listbox">
      {children}
    </div>
  );
}
