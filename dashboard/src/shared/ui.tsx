import { Button as BaseButton } from "@base-ui/react/button";
import { Input as BaseInput } from "@base-ui/react/input";
import { Select as BaseSelect } from "@base-ui/react/select";
import type { ComponentPropsWithRef } from "react";
import { Icon } from "./icons.tsx";
import { usePopupContainer } from "./PopupLayer.tsx";

export function Button({ type = "button", ...props }: ComponentPropsWithRef<"button">) {
  return <BaseButton type={type} {...props} />;
}

export function Input({ type = "text", ...props }: ComponentPropsWithRef<"input">) {
  return <BaseInput type={type} {...props} />;
}

export function Select<Value extends string>({
  id,
  value,
  items,
  onValueChange,
  disabled = false,
}: {
  id: string;
  value: Value;
  items: { value: Value; label: string }[];
  onValueChange: (value: Value) => void;
  disabled?: boolean;
}) {
  const container = usePopupContainer();
  return (
    <BaseSelect.Root
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      disabled={disabled}
    >
      <BaseSelect.Trigger id={id} className="ui-select-trigger">
        <BaseSelect.Value className="ui-select-value" />
        <BaseSelect.Icon className="ui-select-icon">
          <Icon name="chevron" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal container={container ?? undefined}>
        <BaseSelect.Positioner
          className="ui-select-positioner"
          sideOffset={6}
          align="start"
          alignItemWithTrigger={false}
        >
          <BaseSelect.Popup className="ui-select-popup">
            <BaseSelect.List className="ui-select-list">
              {items.map((item) => (
                <BaseSelect.Item key={item.value} value={item.value} className="ui-select-item">
                  <BaseSelect.ItemText>{item.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator className="ui-select-indicator">
                    <Icon name="check" />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
