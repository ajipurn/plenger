import type { MouseEvent, MouseEventHandler, ReactNode, RefAttributes } from "react";
import {
  Button as AriaButton,
  Input as AriaInput,
  Select as AriaSelect,
  TextArea as AriaTextArea,
  type ButtonProps,
  CheckboxButton,
  CheckboxField,
  type CheckboxFieldProps,
  type InputProps,
  ListBox,
  ListBoxItem,
  Popover,
  SelectValue,
  type TextAreaProps,
} from "react-aria-components";
import { Icon } from "./icons.tsx";

export function Button({
  type = "button",
  disabled = false,
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
    >
      <AriaButton id={id} className="ui-select-trigger">
        <SelectValue className="ui-select-value" />
        <span className="ui-select-icon" aria-hidden="true">
          <Icon name="chevron" />
        </span>
      </AriaButton>
      <Popover className="ui-select-popup ui-popover" placement="bottom start" offset={6}>
        <ListBox className="ui-select-list" items={items}>
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
      </Popover>
    </AriaSelect>
  );
}
