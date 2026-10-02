/**
 * Small form controls shared by the views' filter bars. Every text from
 * the board is rendered as text, never as markup.
 */

import type { JSX } from 'preact';

/**
 * The distinct non-null values of `values`, plus `current` when it is not
 * null (so a filter named by the URL hash stays selectable), sorted by
 * string order.
 */
export function sortedUnique(values: readonly (string | null)[], current: string | null): string[] {
  const set = new Set<string>();
  for (const value of values) {
    if (value !== null) {
      set.add(value);
    }
  }
  if (current !== null) {
    set.add(current);
  }
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface SelectProps {
  id: string;
  label: string;
  /** The selected value, or null for `all`. */
  value: string | null;
  options: readonly string[];
  /** Called with the chosen value, null for `all`. */
  onChange: (value: string | null) => void;
}

/** A labelled `select` whose first option is `all` (value `""`, meaning no filter). */
export function Select(props: SelectProps): JSX.Element {
  return (
    <span class="field">
      <label for={props.id}>{props.label}</label>
      <select
        id={props.id}
        value={props.value ?? ''}
        onChange={(e) => {
          const value = e.currentTarget.value;
          props.onChange(value === '' ? null : value);
        }}
      >
        <option value="">all</option>
        {props.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </span>
  );
}

/** The ISO 8601 form of a wall time for a `time` element, or undefined when out of range. */
export function isoTime(ms: number): string | undefined {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
