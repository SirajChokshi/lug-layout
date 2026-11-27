import { useState } from "react";

export function CommitInput({
  value,
  name,
  step,
  ariaLabel,
  parse,
  onCommit,
}: {
  readonly value: string;
  readonly name: string;
  readonly step: string;
  readonly ariaLabel?: string;
  readonly parse: (text: string) => number | null;
  readonly onCommit: (parsed: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  const [typing, setTyping] = useState(false);
  if (shown !== value) {
    setShown(value);
    if (!typing) setDraft(value);
  }
  const revert = (): void => {
    setTyping(false);
    setDraft(value);
  };
  const commit = (): void => {
    if (!typing) return;
    const parsed = draft.trim() === "" ? null : parse(draft);
    revert();
    if (parsed !== null && draft !== value) onCommit(parsed);
  };
  return (
    <input
      type="number"
      step={step}
      name={name}
      aria-label={ariaLabel}
      value={draft}
      onChange={(event) => {
        setTyping(true);
        setDraft(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") revert();
      }}
    />
  );
}

export function wholeNumber(text: string): number | null {
  const parsed = Number(text);
  return Number.isInteger(parsed) ? parsed : null;
}

export function MmField({
  label,
  value,
  onCommit,
  name,
}: {
  readonly label: string;
  readonly value: number;
  readonly onCommit: (mm: number) => void;
  readonly name: string;
}) {
  return (
    <label className="mm-field">
      <span>{label}</span>
      <CommitInput
        value={String(value)}
        name={name}
        step="1"
        parse={wholeNumber}
        onCommit={onCommit}
      />
    </label>
  );
}
