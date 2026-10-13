import type { SVGProps } from 'react'

export type IconProps = SVGProps<SVGSVGElement>

const base = (props: IconProps) => ({
  viewBox: '0 0 20 20',
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...props,
})

export function BrandMarkIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden {...props}>
      <rect x="1.5" y="1.5" width="5" height="5" rx="1.2" fill="currentColor" />
      <rect x="9.5" y="1.5" width="5" height="5" rx="1.2" fill="currentColor" opacity=".55" />
      <rect x="1.5" y="9.5" width="5" height="5" rx="1.2" fill="currentColor" opacity=".55" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1.2" fill="currentColor" opacity=".85" />
    </svg>
  )
}

export function DashboardIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1.4" />
      <rect x="11" y="2.5" width="6.5" height="4" rx="1.4" />
      <rect x="11" y="8.5" width="6.5" height="9" rx="1.4" />
      <rect x="2.5" y="11" width="6.5" height="6.5" rx="1.4" />
    </svg>
  )
}

export function MarketplaceIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 7.5 4.2 3h11.6l1.2 4.5" />
      <path d="M3 7.5a1.9 1.9 0 0 0 3.8 0 1.9 1.9 0 0 0 3.8 0 1.9 1.9 0 0 0 3.8 0 1.9 1.9 0 0 0 3.6 0" />
      <path d="M4 7.8V16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7.8" />
      <path d="M8 17v-4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V17" />
    </svg>
  )
}

/** Capabilities: puzzle piece, the jobs agents can plug into. */
export function CapabilityIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M8 3.5a1.5 1.5 0 0 1 3 0V5h3.5a.5.5 0 0 1 .5.5V9h-1.5a1.5 1.5 0 0 0 0 3H15v3.5a.5.5 0 0 1-.5.5H11v-1.5a1.5 1.5 0 0 0-3 0V16H4.5a.5.5 0 0 1-.5-.5V12h1.5a1.5 1.5 0 0 0 0-3H4V5.5a.5.5 0 0 1 .5-.5H8z" />
    </svg>
  )
}

export function AgentsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="4" y="6" width="12" height="9" rx="2.4" />
      <path d="M10 6V3.2" />
      <circle cx="10" cy="2.2" r="1" fill="currentColor" stroke="none" />
      <circle cx="7.6" cy="10.4" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.4" cy="10.4" r="1.1" fill="currentColor" stroke="none" />
      <path d="M7.6 13.2h4.8" />
      <path d="M2.6 9v3M17.4 9v3" />
    </svg>
  )
}

export function CreateAgentIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 6.6v6.8M6.6 10h6.8" />
    </svg>
  )
}

/** A plug: connect your own agent. */
export function PlugIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7.5 2.5v3.5M12.5 2.5v3.5" />
      <path d="M5 6h10v3a5 5 0 0 1-10 0V6Z" />
      <path d="M10 14v3.5" />
    </svg>
  )
}

export function FlagIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4.5 17.5v-14" />
      <path d="M4.5 3.5h9l-1.8 3.2 1.8 3.3h-9" />
    </svg>
  )
}

export function OrdersIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 2.8h10v14.4l-2.5-1.6-2.5 1.6-2.5-1.6-2.5 1.6z" />
      <path d="M7.2 7h5.6M7.2 10h5.6M7.2 13h3.2" />
    </svg>
  )
}

export function ActivityIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M2.5 10.5h3.2l1.8-5 2.6 9 1.8-6.2 1.4 2.2h4.2" />
    </svg>
  )
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.1 5.1l1.4 1.4M13.5 13.5l1.4 1.4M14.9 5.1l-1.4 1.4M6.5 13.5l-1.4 1.4" />
    </svg>
  )
}

export function HelpIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M7.8 7.8a2.2 2.2 0 1 1 3.2 2c-.9.6-1.2 1-1.2 2" />
      <circle cx="10" cy="14.2" r="0.15" fill="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="9" cy="9" r="5.6" />
      <path d="M13.2 13.2 17.5 17.5" />
    </svg>
  )
}

export function FilterIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 5h14M6 10h8M8.6 15h2.8" />
    </svg>
  )
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 7.5 10 12.5 15 7.5" />
    </svg>
  )
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 10h12" />
      <path d="M11 5.5 16 10l-5 4.5" />
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 10.5 8 14.5 16 5.5" />
    </svg>
  )
}

export function MenuIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 5.5h14M3 10h14M3 14.5h14" />
    </svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 5l10 10M15 5 5 15" />
    </svg>
  )
}

export function ScaleIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M10 3v14M6.5 17h7M4 6h12M10 4.5 4 6M10 4.5 16 6" />
      <path d="M4 6 2 11a2 2 0 0 0 4 0L4 6zM16 6l-2 5a2 2 0 0 0 4 0l-2-5z" />
    </svg>
  )
}

export function TrashIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5 5.5l.8 10.1a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L15 5.5M8.5 9v4.5M11.5 9v4.5" />
    </svg>
  )
}

export function WalletIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="5" width="15" height="11" rx="2.2" />
      <path d="M2.5 8.5h15" />
      <circle cx="14" cy="11.8" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}
