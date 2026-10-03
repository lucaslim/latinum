export const THEMES = [
  { id: "ember", label: "Ember" },
  { id: "paper", label: "Paper" },
  { id: "graphite", label: "Graphite" },
  { id: "porcelain", label: "Porcelain" },
  { id: "midnight", label: "Midnight" },
  { id: "terminal", label: "Terminal" },
  { id: "moss", label: "Moss" },
  { id: "signal", label: "Signal" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME: ThemeId = "ember";
/** What tokens.css shows an OS in light mode until the user picks a theme. */
export const OS_LIGHT_THEME: ThemeId = "paper";
/** Also written into the inline script in `index.html`, which runs before any module loads. */
export const STORAGE_KEY = "tj-theme";

const isThemeId = (value: string | null): value is ThemeId => THEMES.some((t) => t.id === value);

export function savedTheme(): ThemeId | null {
  const saved = localStorage.getItem(STORAGE_KEY);
  return isThemeId(saved) ? saved : null;
}

const OS_LIGHT = "(prefers-color-scheme: light)";

export const osIsLight = (): boolean => matchMedia(OS_LIGHT).matches;

export function subscribeOsLight(onChange: () => void): () => void {
  const query = matchMedia(OS_LIGHT);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** The theme on screen: the saved choice, else whatever tokens.css gives this OS setting. */
export const effectiveTheme = (saved: ThemeId | null, osLight: boolean): ThemeId =>
  saved ?? (osLight ? OS_LIGHT_THEME : DEFAULT_THEME);

export function chooseTheme(id: ThemeId) {
  document.documentElement.dataset.theme = id;
  localStorage.setItem(STORAGE_KEY, id);
}
