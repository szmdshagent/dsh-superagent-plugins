/** 长文本折叠块：默认 3 行预览，只有真正溢出时才出现「展开」；展开后显示全文，控件变为「收起」。 */
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { usePanel } from './provider.tsx'

/**
 * 测量是否溢出（折叠态是否可滚动）。
 * 旧实现用 `-webkit-line-clamp` 做 3 行硬截断，靠「自然高度 vs clamp 高度」判断；现在折叠态改成
 * 「限高 + overflow-y:auto」，直接用 `scrollHeight > clientHeight + 1` 判断框内是否能滚动。
 * 仍需处理的情况：
 * - `useLayoutEffect` 首测 + 一次 `requestAnimationFrame` 复测，等挂载那一帧的布局落定；
 * - 元素可能正处于展开态（没有 `dt-fold`），测量时临时补上 `dt-fold` 并去掉 `is-expanded`，
 *   否则量到的是展开后的无滚动高度，收起后「展开」控件会消失；
 * - 只响应宽度变化（重排）与字体加载，元素自身高度变化不重测，避免测量改样式造成观察者回环。
 */
export function useFold(target: RefObject<HTMLElement>, content: string) {
  const [expanded, setExpanded] = useState(false)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const element = target.current
    if (!element) return
    let disposed = false
    let frame = 0
    let pending = 0
    // 测量期间的样式改动会触发 ResizeObserver，用标记跳过自己造成的那一轮。
    let measuring = false
    const measure = () => {
      if (disposed) return
      measuring = true
      const savedStyle = element.getAttribute('style')
      const hadFoldClass = element.classList.contains('dt-fold')
      const hadExpandedClass = element.classList.contains('is-expanded')
      if (!hadFoldClass) element.classList.add('dt-fold')
      // 展开态没有限高，先临时收起才能量到折叠态的滚动几何。
      if (hadExpandedClass) element.classList.remove('is-expanded')
      try {
        setOverflow(element.scrollHeight > element.clientHeight + 1)
      } finally {
        if (hadExpandedClass) element.classList.add('is-expanded')
        if (savedStyle === null) element.removeAttribute('style')
        else element.setAttribute('style', savedStyle)
        if (!hadFoldClass) element.classList.remove('dt-fold')
        measuring = false
      }
    }
    measure()
    frame = requestAnimationFrame(measure)
    // 字体加载完成会改变换行行数，宽度不变也要重测。
    let active = true
    void document.fonts?.ready.then(() => { if (active) measure() })
    if (typeof ResizeObserver === 'undefined') {
      return () => { active = false; disposed = true; cancelAnimationFrame(frame) }
    }
    let lastWidth = element.clientWidth
    const observer = new ResizeObserver(() => {
      if (measuring || disposed) return
      const width = element.clientWidth
      if (width === lastWidth) return
      lastWidth = width
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(measure)
    })
    observer.observe(element)
    return () => {
      active = false
      disposed = true
      cancelAnimationFrame(frame)
      cancelAnimationFrame(pending)
      observer.disconnect()
    }
  }, [target, content])
  return { expanded, overflow, toggle: () => setExpanded(value => !value) }
}

export function FoldToggle({ shown, expanded, onToggle }: { shown: boolean; expanded: boolean; onToggle: () => void }) {
  const { t } = usePanel()
  if (!shown) return null
  return <button type="button" className="dt-textlink dt-fold-toggle" aria-expanded={expanded} onClick={onToggle}>
    {expanded ? t('collapse') : t('expandShort')}</button>
}

/** 折叠的引用/预览块；调用方包一层 `dt-row-quote`，内容可以是纯文本或 MarkdownLite。 */
export function FoldedText({ text, className, children }: { text: string; className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const { expanded, overflow, toggle } = useFold(ref, text)
  return <>
    <div ref={ref} className={expanded ? `${className} is-expanded` : `${className} dt-fold`} title={text}>{children}</div>
    {/* 展开态始终保留「收起」：窗口变宽后内容可能不再溢出，但已展开的块必须能收回去。 */}
    <FoldToggle shown={overflow || expanded} expanded={expanded} onToggle={toggle} />
  </>
}

/** 折叠的详情页行标题；自带 `dt-row-title` 容器，「展开」控件放在标题下方，避免挤压标题宽度。 */
export function FoldedTitle({ text, title, onClick }: { text: string; title?: string; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const { expanded, overflow, toggle } = useFold(ref, text)
  return <>
    <div className="dt-row-title">
      <button ref={ref} type="button" className={expanded ? 'dt-open is-expanded' : 'dt-open dt-fold'} title={title}
        onClick={onClick}>{text}</button>
    </div>
    {/* 展开态始终保留「收起」：窗口变宽后内容可能不再溢出，但已展开的块必须能收回去。 */}
    <FoldToggle shown={overflow || expanded} expanded={expanded} onToggle={toggle} />
  </>
}