import { useState, useSyncExternalStore } from "react";
import {
  chooseTheme,
  effectiveTheme,
  osIsLight,
  savedTheme,
  subscribeOsLight,
  THEMES,
} from "../theme/themes.ts";

export function ThemeSelect() {
  const [saved, setSaved] = useState(savedTheme);
  const osLight = useSyncExternalStore(subscribeOsLight, osIsLight);

  return (
    <label className="theme-select">
      <span className="label">Theme</span>
      <select
        name="theme"
        value={effectiveTheme(saved, osLight)}
        onChange={(e) => {
          const id = THEMES.find((t) => t.id === e.target.value)?.id;
          if (!id) throw new Error(`Unknown theme: ${e.target.value}`);
          chooseTheme(id);
          setSaved(id);
        }}
      >
        {THEMES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}
