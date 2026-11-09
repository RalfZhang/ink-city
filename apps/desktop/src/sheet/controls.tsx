import type { ReactNode } from "react";

// The sheet's few kinds of control, drawn in ink: a tick box, a row of choices, a
// settings row, the block it sits in and what folds open among them. Kept bare
// — a label, a value, a callback — so every tab reads the same.

/** The tick, as a pen stroke the box draws in when it's ticked (`pathLength` 1 for the dash trick). */
export function TickMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d="M3 8.5 6.6 12 13 4.2" pathLength={1} />
    </svg>
  );
}

export function Check({
  checked,
  label,
  onChange,
  disabled,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="check"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <TickMark />
    </button>
  );
}

export function Pick<T extends string>({
  options,
  value,
  onChange,
  disabled,
  label,
}: {
  options: readonly (readonly [T, string])[];
  value: T | null;
  onChange: (v: T) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <span className="pick" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={v === value} disabled={disabled} onClick={() => v !== value && onChange(v)}>
          {text}
        </button>
      ))}
    </span>
  );
}

/**
 * A settings row: its name and what it does on one side, its control on the other
 * — or, `col`, below them. A failure takes the description's place, in brick, until
 * it's put right.
 */
export function Row({
  label,
  desc,
  error,
  off,
  col,
  children,
}: {
  label: ReactNode;
  desc?: ReactNode;
  error?: string | null;
  off?: boolean;
  col?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`set${col ? " set--col" : ""}${off ? " is-off" : ""}`}>
      <div className="set__t">
        <div className="set__k">{label}</div>
        {error ? (
          <div className="set__d is-bad" role="alert">
            {error}
          </div>
        ) : (
          desc && <div className="set__d">{desc}</div>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * Rows (or anything) that come and go among rows that stay: they fold open and shut
 * rather than popping. Shut, they stay mounted but inert — any state in them is kept,
 * and they can be seen folding away.
 */
export function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`slide-y${open ? "" : " is-shut"}`} inert={!open}>
      <div>{children}</div>
    </div>
  );
}

/** A block of settings: its name in the margin, its rows beside it. */
export function Sec({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="sec">
      <p className="ink-label">{label}</p>
      <div className="sec__rows">{children}</div>
    </section>
  );
}
