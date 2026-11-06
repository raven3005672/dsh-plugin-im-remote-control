/**
 * Browser half of im-remote-control: one Settings page.
 *
 * The page only edits configuration; the Feishu connection and the Session
 * plumbing stay on the Host. Copy is hardcoded Chinese for now — this is a
 * personal plugin, not an official one, so it does not participate in the
 * shell's locale ownership.
 */
import type { ComponentType } from 'react'
import { SettingsSection } from './Section.tsx'
import type { SectionProps } from './Section.tsx'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'im-remote-control'

/** Services this page reads. */
export const inject = ['slots', 'configForms']

/** Settings namespace: the profile row id, which the Host serves as a document. */
const SETTINGS_NAMESPACE = 'dsh-plugin-im-remote-control'

/** The slice of the client Context this page uses; see `src/types.ts` for why it is local. */
export interface ClientContext {
  readonly slots: {
    inject(slot: 'settings.section', run: () => () => void): void
    register(
      definition: {
        readonly name: 'settings.section'
        readonly id: string
        readonly order: number
        readonly label: () => string
        readonly inject: () => { readonly form: unknown }
      },
      component: ComponentType<SectionProps>,
    ): () => void
  }
  readonly configForms: {
    get(namespace: string): SectionProps['form']
  }
}

/**
 * Register the Settings page.
 * @param ctx - client Context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'im-remote-control',
    order: 40,
    // A function, not a string: the label is read at render time so it follows
    // the current language.
    label: () => '远程控制',
    inject: () => ({ form: ctx.configForms.get(SETTINGS_NAMESPACE) }),
  }, SettingsSection))
}
