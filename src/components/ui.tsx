import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

/* ==========================================================================
   Icons — line work at 1.6 stroke, sized for a dense panel.
   ========================================================================== */

export type IconName =
  | 'chevron'
  | 'download'
  | 'pause'
  | 'play'
  | 'x'
  | 'trash'
  | 'folder'
  | 'refresh'
  | 'external'
  | 'search'
  | 'sliders'
  | 'plus'
  | 'check'
  | 'alert'
  | 'layers'
  | 'archive'
  | 'more'
  | 'film'
  | 'audio'
  | 'link'
  | 'spinner'
  | 'pencil'
  | 'captions'

const PATHS: Record<IconName, ReactNode> = {
  chevron: <path d="M6 3.5l4.5 4.5L6 12.5" />,
  download: <path d="M8 2.5v8M4.8 7.3L8 10.5l3.2-3.2M2.5 13.5h11" />,
  pause: <path d="M5.8 3.5v9M10.2 3.5v9" />,
  play: <path d="M5.5 3.4l7 4.6-7 4.6z" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  trash: <path d="M2.8 4.8h10.4M6.4 4.8V3.2h3.2v1.6M4.6 4.8l.6 8.7h5.6l.6-8.7" />,
  folder: <path d="M2 4.2h4.3l1.3 1.7H14v7.1H2z" />,
  refresh: <path d="M13.2 8a5.2 5.2 0 11-1.7-3.85M13.4 2.2v2.9h-2.9" />,
  external: <path d="M9.2 2.8h4v4M13.2 2.8L7.6 8.4M11.4 9.4v3.8H2.8V4.6h3.8" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.4 10.4L14 14" />
    </>
  ),
  sliders: (
    <>
      <path d="M2.5 5.4h3.2M9.6 5.4h4M2.5 10.6h5.2M11.6 10.6h1.9" />
      <circle cx="7.6" cy="5.4" r="1.8" />
      <circle cx="9.6" cy="10.6" r="1.8" />
    </>
  ),
  plus: <path d="M8 3.4v9.2M3.4 8h9.2" />,
  check: <path d="M3.2 8.4l3.2 3.2 6.4-7.2" />,
  alert: (
    <>
      <path d="M8 2.6l5.8 10.8H2.2z" />
      <path d="M8 6.4v3.1" />
      <circle cx="8" cy="11.4" r="0.55" fill="currentColor" stroke="none" />
    </>
  ),
  layers: <path d="M8 2.2l6 2.9-6 2.9-6-2.9zM2 8.6l6 2.9 6-2.9" />,
  archive: <path d="M2.2 3.6h11.6v2.9H2.2zM3.3 6.5v6.5h9.4V6.5M6.4 9h3.2" />,
  more: (
    <>
      <circle cx="3.6" cy="8" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="12.4" cy="8" r="1.05" fill="currentColor" stroke="none" />
    </>
  ),
  film: (
    <>
      <path d="M2.4 3.4h11.2v9.2H2.4z" />
      <path d="M5.4 3.4v9.2M10.6 3.4v9.2" />
    </>
  ),
  audio: (
    <>
      <path d="M3.4 9.6V8a4.6 4.6 0 019.2 0v1.6" />
      <path d="M2.6 9.4h1.8v3.4H2.6zM11.6 9.4h1.8v3.4h-1.8z" />
    </>
  ),
  link: <path d="M6.4 9.6l3.2-3.2M5.1 8L3.7 9.4a2.4 2.4 0 003.4 3.4L8.5 11.4M10.9 8l1.4-1.4a2.4 2.4 0 00-3.4-3.4L7.5 4.6" />,
  spinner: <path d="M8 2.2a5.8 5.8 0 105.8 5.8" />,
  pencil: <path d="M3 13h2.4l7.1-7.1-2.4-2.4L3 10.6zM10.1 3.5l2.4 2.4" />,
  captions: (
    <>
      <path d="M2.2 3.6h11.6v8.8H2.2z" />
      <path d="M6.4 7.1a1.7 1.7 0 100 1.8M11.4 7.1a1.7 1.7 0 100 1.8" />
    </>
  ),
}

export function Icon({
  name,
  size = 14,
  className,
}: {
  name: IconName
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}

/* ==========================================================================
   Buttons
   ========================================================================== */

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'tall'
  icon?: IconName
  spinning?: boolean
}

export function Btn({
  variant = 'default',
  size = 'md',
  icon,
  spinning,
  children,
  className = '',
  ...rest
}: BtnProps) {
  const classes = [
    'btn',
    variant !== 'default' ? variant : '',
    size === 'sm' ? 'sm' : size === 'tall' ? 'tall' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button type="button" className={classes} {...rest}>
      {spinning ? <Icon name="spinner" className="spin" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  )
}

export function IconBtn({
  icon,
  title,
  variant,
  spinning,
  size = 14,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName
  title: string
  variant?: 'danger' | 'on'
  spinning?: boolean
  size?: number
}) {
  return (
    <button
      type="button"
      className={`iconbtn${variant ? ` ${variant}` : ''}`}
      title={title}
      aria-label={title}
      {...rest}
    >
      <Icon name={spinning ? 'spinner' : icon} size={size} className={spinning ? 'spin' : undefined} />
    </button>
  )
}

/* ==========================================================================
   Level meter — the signature readout.
   Discrete segments in a recessed well; the tick grid is painted over the fill
   so segments stay put as it grows.
   ========================================================================== */

export function Meter({
  percent,
  tone = 'running',
  slim = false,
}: {
  percent: number | null
  tone?: 'running' | 'done' | 'paused' | 'bad' | 'queued'
  slim?: boolean
}) {
  const indeterminate = percent === null || percent === undefined
  const classes = ['meter', tone, slim ? 'slim' : '', indeterminate ? 'indeterminate' : '']
    .filter(Boolean)
    .join(' ')
  return (
    <div
      className={classes}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round((percent as number) * 100)}
    >
      <div
        className="meter-fill"
        style={indeterminate ? undefined : { width: `${Math.min(100, Math.max(0, percent * 100))}%` }}
      />
    </div>
  )
}

/* ==========================================================================
   Throughput scope — aggregate transfer rate over the last ~30 seconds.
   ========================================================================== */

export function Scope({ samples, height = 20 }: { samples: number[]; height?: number }) {
  const barW = 2
  const gap = 1
  const peak = Math.max(...samples, 1)
  const total = samples.length
  return (
    <svg
      width={total * (barW + gap) - gap}
      height={height}
      viewBox={`0 0 ${total * (barW + gap) - gap} ${height}`}
      aria-hidden="true"
    >
      {samples.map((value, i) => {
        // Zero samples still draw a baseline tick, so an idle scope reads as an
        // instrument at rest rather than an empty black box.
        const h = value > 0 ? Math.max(2, (value / peak) * height) : 2
        return (
          <rect
            key={i}
            className="scope-bar"
            x={i * (barW + gap)}
            y={height - h}
            width={barW}
            height={h}
            opacity={value > 0 ? 0.45 + 0.55 * (i / (total - 1)) : 0.34}
          />
        )
      })}
    </svg>
  )
}

/* ==========================================================================
   Menu — small dropdown for row actions.
   ========================================================================== */

/**
 * Rendered into a portal with fixed positioning: rows live inside scrolling,
 * rounded, overflow-clipped cards, and a dropdown must escape all of them.
 */
export function Menu({
  title,
  children,
  icon = 'more',
}: {
  title: string
  children: (close: () => void) => ReactNode
  icon?: IconName
}) {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState<{ right: number; top?: number; bottom?: number } | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  const toggle = () => {
    if (open) return setOpen(false)
    const el = wrap.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Flip upwards when the trigger sits near the bottom of the window.
    const flip = window.innerHeight - rect.bottom < 260
    setBox({
      right: Math.max(8, window.innerWidth - rect.right),
      ...(flip
        ? { bottom: window.innerHeight - rect.top + 4 }
        : { top: rect.bottom + 4 }),
    })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (wrap.current?.contains(target) || panel.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    // A fixed panel can't follow its row, so dismiss instead of drifting.
    const dismiss = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [open])

  return (
    <div className="menu-wrap" ref={wrap}>
      <IconBtn
        icon={icon}
        title={title}
        variant={open ? 'on' : undefined}
        onClick={(e) => {
          e.stopPropagation()
          toggle()
        }}
      />
      {open && box
        ? createPortal(
            <div
              className="menu floating"
              role="menu"
              ref={panel}
              style={box}
              onClick={(e) => e.stopPropagation()}
            >
              {children(() => setOpen(false))}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

export function MenuItem({
  icon,
  children,
  danger,
  onClick,
  disabled,
}: {
  icon?: IconName
  children: ReactNode
  danger?: boolean
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item${danger ? ' danger' : ''}`}
      onClick={onClick}
      disabled={disabled}
      style={disabled ? { opacity: 0.4, cursor: 'default' } : undefined}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  )
}

/* ==========================================================================
   Modal
   ========================================================================== */

export function Modal({
  title,
  children,
  footer,
  onClose,
}: {
  title: string
  children: ReactNode
  footer: ReactNode
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">{footer}</div>
      </div>
    </div>
  )
}

/* ==========================================================================
   Small pieces
   ========================================================================== */

export function Chip({
  children,
  tone,
  title,
  lang,
}: {
  children: ReactNode
  tone?: 'site' | 'signal' | 'ok' | 'bad' | 'cat'
  title?: string
  /** Site names are Latin brands: lang="en" keeps uppercase from producing a Turkish dotted İ. */
  lang?: string
}) {
  return (
    <span className={`chip${tone ? ` ${tone}` : ''}`} title={title} lang={lang}>
      {children}
    </span>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" />
      <span style={{ fontSize: 12.5 }}>{label}</span>
    </label>
  )
}

export function Empty({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty-mark">
        <Icon name={icon} size={20} />
      </div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  )
}

export function Thumb({
  src,
  duration,
  audio,
}: {
  src: string | null
  duration: string
  audio?: boolean
}) {
  const [failed, setFailed] = useState(false)
  return (
    <div className="thumb">
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <div className="thumb-fallback">
          <Icon name={audio ? 'audio' : 'film'} size={18} />
        </div>
      )}
      <span className={`timecode${duration === '–' ? ' unknown' : ''}`}>{duration}</span>
    </div>
  )
}
