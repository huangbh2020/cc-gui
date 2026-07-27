/**
 * Input — reusable text input component.
 *
 * Built on @base-ui/react Input primitive with consistent styling.
 *
 * @example
 *   <Input placeholder="Type here..." />
 *   <Input error placeholder="Invalid value" />
 */
import { forwardRef } from "react";
import { Input as BaseInput } from "@base-ui/react/input";
import { cn } from "@renderer/lib/cn.js";

export interface InputProps
  extends React.ComponentPropsWithoutRef<typeof BaseInput> {
  /** Show error styling */
  error?: boolean;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, ...props }, ref) => {
    return (
      <BaseInput
        ref={ref}
        className={cn(
          "min-w-0 w-full rounded border border-edge bg-surface px-2.5 py-1.5 font-mono text-xs text-content placeholder:text-content-subtle outline-none transition-colors",
          "focus:border-accent",
          error && "border-danger focus:border-danger",
          className,
        )}
        {...props}
      />
    );
  },
);

Input.displayName = "Input";

export { Input };
