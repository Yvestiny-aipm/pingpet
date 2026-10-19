import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Search, X } from 'lucide-react'

/* ------------------------------------------------------------------ */
/* 基础按钮                                                             */
/* ------------------------------------------------------------------ */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  loading?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={`pp-btn pp-btn--${variant} pp-btn--${size} ${className}`.trim()}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 size={15} className="pp-spin" /> : icon}
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* 开关                                                                 */
/* ------------------------------------------------------------------ */

export function Switch({
  checked,
  onChange,
  label,
  disabled = false
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`pp-switch${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="pp-switch__knob" />
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* 容器与行                                                             */
/* ------------------------------------------------------------------ */

export function Card({
  children,
  className = '',
  padded = true
}: {
  children: ReactNode
  className?: string
  padded?: boolean
}): JSX.Element {
  return <section className={`pp-card${padded ? ' pp-card--padded' : ''} ${className}`.trim()}>{children}</section>
}

export function Row({
  title,
  desc,
  control,
  icon,
  stacked = false
}: {
  title: ReactNode
  desc?: ReactNode
  control?: ReactNode
  icon?: ReactNode
  stacked?: boolean
}): JSX.Element {
  return (
    <div className={`pp-row${stacked ? ' pp-row--stacked' : ''}`}>
      {icon && <span className="pp-row__icon">{icon}</span>}
      <div className="pp-row__copy">
        <div className="pp-row__title">{title}</div>
        {desc && <div className="pp-row__desc">{desc}</div>}
      </div>
      {control && <div className="pp-row__control">{control}</div>}
    </div>
  )
}

export function SectionHead({
  title,
  hint,
  action
}: {
  title: string
  hint?: ReactNode
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="pp-section-head">
      <div>
        <h2>{title}</h2>
        {hint && <p>{hint}</p>}
      </div>
      {action}
    </div>
  )
}

export function PageHead({
  title,
  subtitle,
  actions
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
}): JSX.Element {
  return (
    <header className="pp-page-head">
      <div className="pp-page-head__copy">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="pp-page-head__actions">{actions}</div>}
    </header>
  )
}

/* ------------------------------------------------------------------ */
/* 分段选择器                                                           */
/* ------------------------------------------------------------------ */

export interface SegmentOption<T extends string | number> {
  value: T
  label: string
  disabled?: boolean
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label
}: {
  options: ReadonlyArray<SegmentOption<T>>
  value: T
  onChange: (value: T) => void
  label: string
}): JSX.Element {
  return (
    <div className="pp-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          disabled={option.disabled}
          className={`pp-segmented__item${option.value === value ? ' is-active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 搜索框                                                               */
/* ------------------------------------------------------------------ */

export function SearchBox({
  value,
  onChange,
  placeholder,
  ariaLabel
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel?: string
}): JSX.Element {
  return (
    <label className="pp-search">
      <Search size={15} strokeWidth={1.9} />
      <input
        value={value}
        aria-label={ariaLabel ?? placeholder}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <button type="button" className="pp-search__clear" aria-label="清空搜索" onClick={() => onChange('')}>
          <X size={13} />
        </button>
      )}
    </label>
  )
}

/* ------------------------------------------------------------------ */
/* 标签                                                                 */
/* ------------------------------------------------------------------ */

type BadgeTone = 'neutral' | 'accent' | 'sage' | 'amber' | 'danger'

export function Badge({
  children,
  tone = 'neutral',
  dot = false
}: {
  children: ReactNode
  tone?: BadgeTone
  dot?: boolean
}): JSX.Element {
  return (
    <span className={`pp-badge pp-badge--${tone}`}>
      {dot && <span className="pp-badge__dot" />}
      {children}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* 对话框                                                               */
/* ------------------------------------------------------------------ */

export function Dialog({
  title,
  description,
  children,
  onClose,
  footer
}: {
  title: string
  description?: ReactNode
  children?: ReactNode
  onClose: () => void
  footer?: ReactNode
}): JSX.Element {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    // 有输入框时优先聚焦输入框；确认类对话框则聚焦主操作按钮（不聚焦关闭按钮）
    const focusTarget = panelRef.current?.querySelector<HTMLElement>(
      'input, textarea, select, .pp-dialog__foot .pp-btn--danger, .pp-dialog__foot .pp-btn--primary'
    )
    focusTarget?.focus()
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return createPortal(
    <div className="pp-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className="pp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="pp-dialog__head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="pp-dialog__close" aria-label="关闭" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        {description && <p className="pp-dialog__desc">{description}</p>}
        {children && <div className="pp-dialog__body">{children}</div>}
        {footer && <div className="pp-dialog__foot">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

/* ------------------------------------------------------------------ */
/* 空状态 / 加载 / 提示                                                 */
/* ------------------------------------------------------------------ */

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <div className="pp-loading">
      <Loader2 size={18} className="pp-spin" />
      {label && <span>{label}</span>}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action
}: {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="pp-empty">
      {icon && <div className="pp-empty__icon">{icon}</div>}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && <div className="pp-empty__action">{action}</div>}
    </div>
  )
}

export function Callout({
  tone = 'neutral',
  icon,
  children
}: {
  tone?: 'neutral' | 'sage' | 'amber' | 'danger'
  icon?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <div className={`pp-callout pp-callout--${tone}`}>
      {icon && <span className="pp-callout__icon">{icon}</span>}
      <div className="pp-callout__body">{children}</div>
    </div>
  )
}
