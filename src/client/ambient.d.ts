/**
 * Ambient declarations for the browser module table.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is seeded by the Web shell at runtime
 * and never bundled, so the package is not installed here. These declarations
 * describe exactly the exports this plugin uses; they are a contract with the
 * shell, not a copy of its implementation.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, InputHTMLAttributes, ReactNode } from 'react'

  /** Single-line text input. */
  export const Input: ComponentType<
    InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }
  >

  /** Fully controlled checkbox. */
  export const Checkbox: ComponentType<{
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string
    className?: string
  }>
}
