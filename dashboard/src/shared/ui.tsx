import {
  type MouseEvent,
  type MouseEventHandler,
  type ReactNode,
  type RefAttributes,
  useRef,
  useState,
} from "react";
import {
  Button as AriaButton,
  Input as AriaInput,
  Select as AriaSelect,
  TextArea as AriaTextArea,
  Autocomplete,
  type ButtonProps,
  CheckboxButton,
  CheckboxField,
  type CheckboxFieldProps,
  type InputProps,
  ListBox,
  ListBoxItem,
  Popover,
  SearchField,
  SelectValue,
  type TextAreaProps,
  useFilter,
} from "react-aria-components";
import { flushSync } from "react-dom";
import { SELECT_SEARCH_MIN_OPTIONS } from "../../../src/dashboard/contract.ts";
import { Icon } from "./icons.tsx";

export function Button({
  type = "button",
  disabled = false,
  title,
  onClick,
  ...props
}: Omit<ButtonProps, "onClick" | "render"> &
  RefAttributes<HTMLButtonElement> & {
    disabled?: boolean;
    title?: string;
    onClick?: MouseEventHandler<HTMLButtonElement>;
  }) {
  return (
    <AriaButton
      type={type}
      isDisabled={disabled}
      {...props}
      // React Aria drops `title` from a button's DOM props, so it is added on render.
      {...(title ? { render: (dom) => <button {...dom} title={title} /> } : {})}
      // This wrapper always renders a button, so callers receive its concrete DOM type.
      {...(onClick ? { onClick: (event) => onClick(event as MouseEvent<HTMLButtonElement>) } : {})}
    />
  );
}

export function Input({ type = "text", ...props }: InputProps & RefAttributes<HTMLInputElement>) {
  return <AriaInput type={type} {...props} />;
}

export function TextArea(props: TextAreaProps & RefAttributes<HTMLTextAreaElement>) {
  return <AriaTextArea {...props} />;
}

export function Checkbox({
  children,
  className = "",
  ...props
}: Omit<CheckboxFieldProps, "children" | "className"> & {
  children: ReactNode;
  className?: string;
}) {
  return (
    <CheckboxField {...props} className="ui-checkbox-field">
      <CheckboxButton className={`ui-checkbox ${className}`}>
        <span className="ui-checkbox-indicator" aria-hidden="true">
          <Icon name="check" />
        </span>
        <span>{children}</span>
      </CheckboxButton>
    </CheckboxField>
  );
}

export function Select<Value extends string>({
  id,
  label,
  value,
  items,
  onValueChange,
  disabled = false,
  placeholder,
}: {
  id: string;
  label: string;
  value: Value;
  items: { value: Value; label: string }[];
  onValueChange: (value: Value) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(true);
  const { contains } = useFilter({ sensitivity: "base" });
  const searchable = items.length >= SELECT_SEARCH_MIN_OPTIONS;
  function openChange(next: boolean) {
    setIsOpen(next);
    setQuery("");
    if (next) restoreFocus.current = true;
    else if (searchable && restoreFocus.current)
      requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }
  const options = (
    <ListBox
      className="ui-select-list"
      items={items}
      renderEmptyState={() => <div className="ui-select-empty">No matching options.</div>}
    >
      {(item) => (
        <ListBoxItem id={item.value} textValue={item.label} className="ui-select-item">
          {({ isSelected }) => (
            <>
              <span>{item.label}</span>
              <span className="ui-select-indicator" aria-hidden="true">
                {isSelected && <Icon name="check" />}
              </span>
            </>
          )}
        </ListBoxItem>
      )}
    </ListBox>
  );
  return (
    <AriaSelect
      className="ui-select"
      aria-label={label}
      {...(placeholder === undefined ? {} : { placeholder })}
      value={value}
      onChange={(next) => {
        const item = items.find((item) => item.value === next);
        if (item) onValueChange(item.value);
      }}
      isDisabled={disabled}
      isOpen={isOpen}
      onOpenChange={openChange}
    >
      <AriaButton ref={trigger} id={id} className="ui-select-trigger">
        <SelectValue className="ui-select-value" />
        <span className="ui-select-icon" aria-hidden="true">
          <Icon name="chevron" />
        </span>
      </AriaButton>
      <Popover className="ui-select-popup ui-popover" placement="bottom start" offset={6}>
        {searchable ? (
          <Autocomplete<{ value: Value; label: string }>
            inputValue={query}
            onInputChange={setQuery}
            filter={(text, input, node) =>
              contains(text, input.trim()) || contains(node.value?.value ?? "", input.trim())
            }
          >
            <SearchField aria-label={`Search ${label}`} autoFocus className="ui-select-search">
              <Icon name="search" />
              <AriaInput
                placeholder="Search options…"
                onKeyDownCapture={(event) => {
                  if (event.key === "Tab") {
                    event.stopPropagation();
                    restoreFocus.current = false;
                    // Remove the popup's focus trap before native Tab navigation resumes.
                    flushSync(() => openChange(false));
                    trigger.current?.focus({ preventScroll: true });
                  }
                  if (event.key === "Escape") {
                    // The drawer handles Escape during capture. Close only this popup.
                    event.preventDefault();
                    event.stopPropagation();
                    openChange(false);
                  }
                }}
              />
              <AriaButton
                type="button"
                className="ui-select-search-clear"
                aria-label="Clear search"
              >
                <Icon name="close" />
              </AriaButton>
            </SearchField>
            {options}
          </Autocomplete>
        ) : (
          options
        )}
      </Popover>
    </AriaSelect>
  );
}
