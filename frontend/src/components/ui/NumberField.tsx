"use client";

import { useEffect, useState, type ComponentProps } from "react";

type Props = Omit<ComponentProps<"input">, "value" | "onChange" | "type"> & {
  value: number;
  onValueChange: (n: number) => void;
};

/**
 * A numeric input you can actually clear.
 *
 * Binding a number straight to `value` turns every clearing keystroke into
 * `Number("") === 0`, so the box re-renders as "0", the caret sits after it,
 * and the next thing you type reads "035000". Holding the raw string here and
 * lifting only a parsed number means an empty box stays empty while you retype.
 */
export default function NumberField({ value, onValueChange, ...rest }: Props) {
  const [text, setText] = useState(() => String(value));

  // Presets and resets change `value` from outside. Adopt those, but don't
  // stomp on a string the user is mid-way through that already means this
  // number ("35000." while typing, say).
  useEffect(() => {
    setText((prev) => (prev.trim() !== "" && Number(prev) === value ? prev : String(value)));
  }, [value]);

  return (
    <input
      {...rest}
      type="number"
      inputMode="numeric"
      value={text}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        if (next.trim() === "") return; // an empty box is a valid thing to be, briefly
        const n = Number(next);
        if (Number.isFinite(n)) onValueChange(n);
      }}
      onBlur={(e) => {
        // Leaving the field empty or half-typed snaps back to the last good value.
        if (text.trim() === "" || !Number.isFinite(Number(text))) setText(String(value));
        rest.onBlur?.(e);
      }}
    />
  );
}
