/**
 * Teams theme integration.
 *
 * Teams hosts every tab in one of three themes -- "default" (light), "dark",
 * or "contrast" (Windows high-contrast) -- and notifies the app of changes at
 * runtime via `app.registerOnThemeChangeHandler`. We never hardcode a hex
 * value in a component; instead every colour is expressed as a CSS custom
 * property (see src/styles/tokens.css) and this module is the single place
 * that writes those properties, keeping the mapping auditable.
 */
import { app } from '@microsoft/teams-js';

export type TrialPulseTheme = 'default' | 'dark' | 'contrast';

/** All tokens declared in src/styles/tokens.css must appear in every theme below. */
export const THEME_TOKENS: Record<TrialPulseTheme, Record<string, string>> = {
  default: {
    '--tp-color-bg': '#ffffff',
    '--tp-color-bg-subtle': '#f5f5f5',
    '--tp-color-bg-raised': '#ffffff',
    '--tp-color-fg': '#242424',
    '--tp-color-fg-muted': '#5b5b5b',
    '--tp-color-border': '#d1d1d1',
    '--tp-color-border-strong': '#8a8a8a',
    '--tp-color-accent': '#3f3d8a',
    '--tp-color-accent-fg': '#ffffff',
    '--tp-color-accent-subtle-bg': '#eceafd',
    '--tp-color-danger': '#a4262c',
    '--tp-color-danger-bg': '#fdf3f4',
    '--tp-color-danger-fg': '#5c0a0a',
    '--tp-color-info-bg': '#eff6fc',
    '--tp-color-info-fg': '#1a3d5c',
    '--tp-color-info-border': '#b4d6ef',
    '--tp-color-focus-ring': '#3f3d8a',
    '--tp-status-pending-bg': '#e4e4e4',
    '--tp-status-pending-fg': '#3d3d3d',
    '--tp-status-indexed-bg': '#c9f0c9',
    '--tp-status-indexed-fg': '#0b3d0b',
    '--tp-status-failed-bg': '#f8d2d2',
    '--tp-status-failed-fg': '#5c0a0a',
    '--tp-status-outdated-bg': '#faeab0',
    '--tp-status-outdated-fg': '#5c4400',
    '--tp-chart-1': '#4c6ef5',
    '--tp-chart-2': '#12b886',
    '--tp-chart-3': '#f76707',
    '--tp-chart-4': '#ae3ec9',
    '--tp-chart-5': '#e64980',
    '--tp-chart-6': '#82c91e',
    '--tp-chart-cost-line': '#3f3d8a',
    '--tp-chart-budget-line': '#a4262c',
    '--tp-chart-grid': '#e1e1e1',
  },
  dark: {
    '--tp-color-bg': '#1f1f1f',
    '--tp-color-bg-subtle': '#292929',
    '--tp-color-bg-raised': '#2d2d2d',
    '--tp-color-fg': '#f3f2f1',
    '--tp-color-fg-muted': '#c7c7c7',
    '--tp-color-border': '#484848',
    '--tp-color-border-strong': '#6e6e6e',
    '--tp-color-accent': '#9b9dea',
    '--tp-color-accent-fg': '#141414',
    '--tp-color-accent-subtle-bg': '#312f5c',
    '--tp-color-danger': '#f1707b',
    '--tp-color-danger-bg': '#3a1414',
    '--tp-color-danger-fg': '#f8d2d2',
    '--tp-color-info-bg': '#152736',
    '--tp-color-info-fg': '#bfe0f7',
    '--tp-color-info-border': '#2c4a63',
    '--tp-color-focus-ring': '#9b9dea',
    '--tp-status-pending-bg': '#3d3d3d',
    '--tp-status-pending-fg': '#e4e4e4',
    '--tp-status-indexed-bg': '#123a12',
    '--tp-status-indexed-fg': '#c9f0c9',
    '--tp-status-failed-bg': '#4a0e0e',
    '--tp-status-failed-fg': '#f8d2d2',
    '--tp-status-outdated-bg': '#4a3900',
    '--tp-status-outdated-fg': '#faeab0',
    '--tp-chart-1': '#748ffe',
    '--tp-chart-2': '#3ddab0',
    '--tp-chart-3': '#ff922e',
    '--tp-chart-4': '#d17ae0',
    '--tp-chart-5': '#f374a3',
    '--tp-chart-6': '#a8e34d',
    '--tp-chart-cost-line': '#9b9dea',
    '--tp-chart-budget-line': '#f1707b',
    '--tp-chart-grid': '#3d3d3d',
  },
  contrast: {
    '--tp-color-bg': '#000000',
    '--tp-color-bg-subtle': '#000000',
    '--tp-color-bg-raised': '#000000',
    '--tp-color-fg': '#ffffff',
    '--tp-color-fg-muted': '#ffffff',
    '--tp-color-border': '#ffffff',
    '--tp-color-border-strong': '#ffffff',
    '--tp-color-accent': '#ffff00',
    '--tp-color-accent-fg': '#000000',
    '--tp-color-accent-subtle-bg': '#000000',
    '--tp-color-danger': '#ff4040',
    '--tp-color-danger-bg': '#000000',
    '--tp-color-danger-fg': '#ff4040',
    '--tp-color-info-bg': '#000000',
    '--tp-color-info-fg': '#3ff23f',
    '--tp-color-info-border': '#3ff23f',
    '--tp-color-focus-ring': '#ffff00',
    '--tp-status-pending-bg': '#000000',
    '--tp-status-pending-fg': '#ffffff',
    '--tp-status-indexed-bg': '#000000',
    '--tp-status-indexed-fg': '#3ff23f',
    '--tp-status-failed-bg': '#000000',
    '--tp-status-failed-fg': '#ff4040',
    '--tp-status-outdated-bg': '#000000',
    '--tp-status-outdated-fg': '#ffff00',
    '--tp-chart-1': '#00ffff',
    '--tp-chart-2': '#00ff00',
    '--tp-chart-3': '#ff8000',
    '--tp-chart-4': '#ff00ff',
    '--tp-chart-5': '#ffffff',
    '--tp-chart-6': '#ffff00',
    '--tp-chart-cost-line': '#ffff00',
    '--tp-chart-budget-line': '#ff4040',
    '--tp-chart-grid': '#ffffff',
  },
};

/** Normalise the loosely-typed string Teams gives us into our theme union. */
export function resolveTeamsTheme(themeName: string | null | undefined): TrialPulseTheme {
  if (themeName === 'dark') return 'dark';
  if (themeName === 'contrast') return 'contrast';
  return 'default';
}

export function applyTheme(theme: TrialPulseTheme, root: HTMLElement = document.documentElement): void {
  const tokens = THEME_TOKENS[theme];
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value);
  }
  root.dataset.tpTheme = theme;
  root.style.colorScheme = theme === 'default' ? 'light' : 'dark';
}

/**
 * Wires up Teams theme change notifications. Safe to call outside a Teams
 * host (e.g. the standalone dev server): failures are swallowed and the
 * light default theme tokens already baked into tokens.css remain in effect.
 */
export function initThemeSync(onChange?: (theme: TrialPulseTheme) => void): void {
  const handle = (theme: TrialPulseTheme) => {
    applyTheme(theme);
    onChange?.(theme);
  };

  app
    .getContext()
    .then((ctx) => handle(resolveTeamsTheme(ctx.app.theme)))
    .catch(() => {
      /* Not running inside Teams (e.g. local dev) -- keep the default theme. */
    });

  try {
    app.registerOnThemeChangeHandler((themeName) => handle(resolveTeamsTheme(themeName)));
  } catch {
    /* registerOnThemeChangeHandler requires app.initialize() to have resolved
       in a real Teams host; harmless to skip outside one. */
  }
}
