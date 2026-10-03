import { Button as BaseButton } from "@base-ui/react/button";
import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentPropsWithRef } from "react";

export function Button({ type = "button", ...props }: ComponentPropsWithRef<"button">) {
  return <BaseButton type={type} {...props} />;
}

export function Input({ type = "text", ...props }: ComponentPropsWithRef<"input">) {
  return <BaseInput type={type} {...props} />;
}
