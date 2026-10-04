import type { Ref } from "react";
import { Icon } from "./icons.tsx";
import { Input } from "./ui.tsx";

export function SearchField({
  as: Wrapper = "div",
  id,
  label,
  placeholder,
  value,
  onChange,
  inputClassName,
  ref,
}: {
  as?: "div" | "span";
  id: string;
  /** Omit when the caller renders its own label around the field. */
  label?: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  inputClassName?: string;
  ref?: Ref<HTMLInputElement>;
}) {
  return (
    <Wrapper className="search-field">
      <Icon name="search" />
      {label !== undefined && (
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
      )}
      <Input
        {...(ref ? { ref } : {})}
        id={id}
        type="search"
        {...(inputClassName ? { className: inputClassName } : {})}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Wrapper>
  );
}
