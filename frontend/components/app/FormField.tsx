import type { ReactNode } from 'react'

export const FIELD_CLASS =
  'w-full rounded-xl border border-white/[0.08] bg-[#0B0C11] px-3.5 py-2.5 text-[13.5px] text-[#F5F5F7] shadow-[inset_2px_2px_6px_rgba(0,0,0,.4)] placeholder:text-[#54565F] focus:outline-none focus:border-[#5B5FEF]/50'

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  /** Small helper text under the input, e.g. a character counter. */
  hint?: ReactNode
  error?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-[#8B8D96]">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-[11.5px] text-[#EF4444]">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[11.5px] text-[#54565F]">{hint}</span>
      ) : null}
    </label>
  )
}

/** "123 / 500", turns red past the limit. */
export function CharCount({ value, max }: { value: string; max: number }) {
  return <span className={value.length > max ? 'text-[#EF4444]' : undefined}>{value.length} / {max}</span>
}
