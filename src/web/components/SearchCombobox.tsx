import { useEffect, useId, useRef, useState } from "react";
import "./search-combobox.css";

export type ComboOption<Value extends string> = {
  value: Value;
  label: string;
  group: string;
  detail?: string;
  tone?: "credit" | "debit";
};

export function SearchCombobox<Value extends string>({
  label,
  value,
  displayValue,
  options,
  onPick,
  freeText,
}: {
  label: string;
  value: Value;
  displayValue: string;
  options: (query: string) => ComboOption<Value>[];
  onPick: (value: Value) => void;
  freeText?: {
    normalize: (query: string) => Value;
    onQueryChange?: (query: Value | null) => void;
  };
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const activeOption = useRef<HTMLDivElement>(null);
  const choices = options(query ?? "");
  const groups = [...new Set(choices.map((option) => option.group))];
  useEffect(() => {
    if (open && active >= 0) activeOption.current?.scrollIntoView({ block: "nearest" });
  }, [open, active]);
  const close = () => {
    setOpen(false);
    setQuery(null);
    freeText?.onQueryChange?.(null);
    setActive(-1);
  };
  const pick = (next: Value) => {
    onPick(next);
    close();
  };
  return (
    <div className="search-combobox">
      <label>
        {label}
        <input
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? `${id}-list` : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && choices[active] ? `${id}-option-${active}` : undefined}
          autoComplete="off"
          autoCapitalize={freeText ? "characters" : "none"}
          value={open ? (query ?? displayValue) : displayValue}
          onFocus={(event) => {
            setOpen(true);
            event.target.select();
          }}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            const next = freeText ? freeText.normalize(event.target.value) : event.target.value;
            setQuery(next);
            if (freeText) freeText.onQueryChange?.(freeText.normalize(event.target.value));
            setActive(-1);
            setOpen(true);
          }}
          onBlur={() => {
            if (open && query !== null && freeText) onPick(freeText.normalize(query));
            close();
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActive((current) =>
                choices.length === 0
                  ? -1
                  : event.key === "ArrowDown"
                    ? (current + 1) % choices.length
                    : (current <= 0 ? choices.length : current) - 1,
              );
            } else if (event.key === "Enter" && open) {
              event.preventDefault();
              if (active < 0 && query === null) {
                close();
              } else if (freeText && active < 0 && query !== null) {
                pick(freeText.normalize(query));
              } else {
                const option = choices[active < 0 ? 0 : active];
                if (option) pick(option.value);
              }
            } else if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        />
      </label>
      {open && (
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label={`${label} choices`}
          className="combo-popup"
          onMouseDown={(event) => event.preventDefault()}
        >
          {groups.map((group, groupIndex) => (
            <fieldset key={group} aria-labelledby={`${id}-group-${groupIndex}`}>
              <legend id={`${id}-group-${groupIndex}`} className="combo-group">
                {group}
              </legend>
              {choices.map(
                (option, index) =>
                  option.group === group && (
                    // biome-ignore lint/a11y/useFocusableInteractive: Combobox focus stays on the input with aria-activedescendant.
                    // biome-ignore lint/a11y/useKeyWithClickEvents: The input handles option selection with Arrow keys and Enter.
                    <div
                      key={option.value}
                      id={`${id}-option-${index}`}
                      role="option"
                      aria-selected={option.value === value}
                      ref={active === index ? activeOption : undefined}
                      className={`combo-option${active === index ? " combo-active" : ""}`}
                      onClick={() => pick(option.value)}
                    >
                      <span className={option.tone ? `combo-${option.tone}` : undefined}>
                        {option.label}
                      </span>
                      {option.detail && <small>{option.detail}</small>}
                    </div>
                  ),
              )}
            </fieldset>
          ))}
          {choices.length === 0 && <div className="combo-group">No matches</div>}
        </div>
      )}
    </div>
  );
}
