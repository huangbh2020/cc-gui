/**
 * Theme / color-scheme domain types.
 *
 * `ThemeName` is the user's *preference* (what they picked in Settings); it
 * may be "system", which resolves at runtime to either dark or light based on
 * the OS. `EffectiveTheme` is that resolved value — what's actually rendering.
 */

/** User-selectable theme preference. */
export type ThemeName = "dark" | "light" | "system";

/** The theme currently in effect (system resolved down to one of these). */
export type EffectiveTheme = "dark" | "light";

/** Payload of the theme.changed push event (main → renderer). */
export interface ThemeChangedMessage {
  /** Push channel discriminator — distinguishes this from claude/terminal events. */
  channel: "theme:changed";
  /** The user's persisted preference. */
  theme: ThemeName;
  /** What's actually rendering right now (system resolved). */
  effective: EffectiveTheme;
}
