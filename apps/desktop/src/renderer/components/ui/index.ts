/**
 * UI component barrel export.
 *
 * All reusable UI components live in this directory and are exported
 * from here. Import from @renderer/components/ui/index.js.
 *
 * @example
 *   import { Button, Input, Dialog } from "@renderer/components/ui/index.js";
 */
export { Button, buttonVariants } from "./button.js";
export type { ButtonProps } from "./button.js";

export { Input } from "./input.js";
export type { InputProps } from "./input.js";

export { Dialog } from "./dialog.js";
export type {
  DialogRootProps,
  DialogBackdropProps,
  DialogPopupProps,
  DialogTitleProps,
  DialogDescriptionProps,
  DialogCloseProps,
  DialogTriggerProps,
} from "./dialog.js";

export { Select } from "./select.js";
export type {
  SelectRootProps,
  SelectTriggerProps,
  SelectValueProps,
  SelectPopupProps,
  SelectListProps,
  SelectItemProps,
  SelectGroupProps,
  SelectGroupLabelProps,
  SelectSeparatorProps,
} from "./select.js";
