/**
 * Button — reusable button component.
 *
 * Built on @base-ui/react Button primitive + cva() variant management.
 *
 * @example
 *   <Button>Default</Button>
 *   <Button variant="primary" size="sm">Save</Button>
 *   <Button variant="danger" disabled>Delete</Button>
 */
import { forwardRef } from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/cn.js";

const buttonVariants = cva(
  // Base styles
  "inline-flex items-center justify-center gap-1 rounded font-medium transition-colors select-none outline-none",
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-surface hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed",
        secondary:
          "bg-surface-muted text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50 disabled:cursor-not-allowed",
        ghost:
          "text-content-muted hover:bg-surface-muted hover:text-content disabled:opacity-50 disabled:cursor-not-allowed",
        danger:
          "text-danger hover:bg-danger/10 disabled:opacity-50 disabled:cursor-not-allowed",
        outline:
          "border border-edge bg-surface text-content-muted hover:bg-surface-muted hover:text-content disabled:opacity-50 disabled:cursor-not-allowed",
      },
      size: {
        sm: "h-6 px-2 text-[11px]",
        md: "h-8 px-3 text-xs",
        icon: "h-6 w-6 p-0",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "sm",
    },
  },
);

export interface ButtonProps
  extends React.ComponentPropsWithoutRef<typeof BaseButton>,
    VariantProps<typeof buttonVariants> {}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <BaseButton
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);

Button.displayName = "Button";

export { Button, buttonVariants };
