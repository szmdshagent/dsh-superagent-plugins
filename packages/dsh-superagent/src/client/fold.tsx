/** 长文本折叠块：默认 3 行预览，只有真正溢出时才出现「展开」；展开后显示全文，控件变为「收起」。 */
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { usePanel } from './provider.tsx'

/**
 * 测量是否溢出。
 * 旧实现只在挂载时用 `useEffect` 测一次，并且只观察元素自身尺寸：折叠态高度被 clamp 固定在 3 行，
 * 字体/父级宽度稳定后内容变高也不会改变元素高度，ResizeObserver 不会再次触发，真正被裁剪的块因此
 * 一直拿不到「展开」控件。这里改成：
 * - `useLayoutEffect` 首测 + 一次 `requestAnimationFrame` 复测，等挂载那一帧的布局落定；
 * - 测量时临时去掉 clamp 取自然高度，再套 3 行 clamp 取折叠高度，两者比较，不依赖被裁剪后的 scrollHeight；
 * - 展开态（`is-expanded`）测量时临时补上 `dt-fold`，让 `.dt-fold .dt-md` 的块级规则生效，
 *   否则 Firefox 下 flex 子块会让 line-clamp 失效、宽度变化后误判为不溢出；
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
      if (!hadFoldClass) element.classList.add('dt-fold')
      try {
        // 自然高度：普通块布局，不裁剪。
        element.style.display = 'block'
        element.style.setProperty('-webkit-line-clamp', 'unset')
        element.style.setProperty('-webkit-box-orient', 'initial')
        element.style.overflow = 'visible'
        const natural = element.scrollHeight
        // 折叠高度：套用与 CSS 一致的 3 行 clamp。
        element.style.display = '-webkit-box'
        element.style.setProperty('-webkit-line-clamp', '3')
        element.style.setProperty('-webkit-box-orient', 'vertical')
        element.style.overflow = 'hidden'
        const clamped = element.clientHeight
        setOverflow(natural > clamped + 1)
      } finally {
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