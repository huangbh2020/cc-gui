/**
 * Dialog — reusable modal dialog component.
 *
 * Built on @base-ui/react Dialog primitive. Provides Backdrop, Popup,
 * Title, Description, Close, and Trigger subcomponents.
 *
 * @example
 *   <Dialog.Root open={isOpen} onOpenChange={setIsOpen}>
 *     <Dialog.Trigger asChild>
 *       <Button>Open</Button>
 *     </Dialog.Trigger>
 *     <Dialog.Portal>
 *       <Dialog.Backdrop />
 *       <Dialog.Popup>
 *         <Dialog.Title>Dialog Title</Dialog.Title>
 *         <Dialog.Description>Dialog description</Dialog.Description>
 *         <Dialog.Close />
 *       </Dialog.Popup>
 *     </Dialog.Portal>
 *   </Dialog.Root>
 */
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { cn } from "@renderer/lib/cn.js";
import { IconX } from "@renderer/lib/icons.js";

/* ───────── Root ───────── */

/**
 * Dialog Root — state container, does NOT render its own HTML element,
 * so it does NOT accept className.
 */
export type DialogRootProps = React.ComponentPropsWithoutRef<typeof BaseDialog.Root>;

function DialogRoot(props: DialogRootProps) {
  return <BaseDialog.Root {...props} />;
}

/* ───────── Portal ───────── */

function DialogPortal(
  props: React.ComponentPropsWithoutRef<typeof BaseDialog.Portal>,
) {
  return <BaseDialog.Portal {...props} />;
}

/* ───────── Backdrop ───────── */

export interface DialogBackdropProps
  extends React.ComponentPropsWithoutRef<typeof BaseDialog.Backdrop> {}

function DialogBackdrop({ className, ...props }: DialogBackdropProps) {
  return (
    <BaseDialog.Backdrop
      className={cn(
        "fixed inset-0 z-50 bg-black/60 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 transition-opacity",
        className,
      )}
      {...props}
    />
  );
}

/* ───────── Popup ───────── */

export interface DialogPopupProps
  extends React.ComponentPropsWithoutRef<typeof BaseDialog.Popup> {}

function DialogPopup({ className, ...props }: DialogPopupProps) {
  return (
    <BaseDialog.Popup
      className={cn(
        "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
        "rounded-lg border border-edge bg-surface shadow-2xl",
        "data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
        "transition-[transform,opacity] duration-150",
        className,
      )}
      {...props}
    />
  );
}

/* ───────── Title ───────── */

export interface DialogTitleProps
  extends React.ComponentPropsWithoutRef<typeof BaseDialog.Title> {}

function DialogTitle({ className, ...props }: DialogTitleProps) {
  return (
    <BaseDialog.Title
      className={cn("text-sm font-semibold text-content", className)}
      {...props}
    />
  );
}

/* ───────── Description ───────── */

export interface DialogDescriptionProps
  extends React.ComponentPropsWithoutRef<typeof BaseDialog.Description> {}

function DialogDescription({ className, ...props }: DialogDescriptionProps) {
  return (
    <BaseDialog.Description
      className={cn("text-xs text-content-muted", className)}
      {...props}
    />
  );
}

/* ───────── Close ───────── */

export interface DialogCloseProps
  extends React.ComponentPropsWithoutRef<typeof BaseDialog.Close> {}

function DialogClose({ className, children, ...props }: DialogCloseProps) {
  return (
    <BaseDialog.Close
      className={cn(
        "absolute right-3 top-3 rounded p-0.5 text-content-subtle hover:bg-surface-muted hover:text-content-muted transition-colors",
        className,
      )}
      {...props}
    >
      {children ?? <IconX size={16} />}
    </BaseDialog.Close>
  );
}

/* ───────── Trigger ───────── */

export interface DialogTriggerProps
  extends React.ComponentPropsWithoutRef<typeof BaseDialog.Trigger> {}

function DialogTrigger({ className, ...props }: DialogTriggerProps) {
  return (
    <BaseDialog.Trigger
      className={cn(
        "inline-flex items-center justify-center",
        className,
      )}
      {...props}
    />
  );
}

/* ───────── Compound export ───────── */

export const Dialog = {
  Root: DialogRoot,
  Portal: DialogPortal,
  Backdrop: DialogBackdrop,
  Popup: DialogPopup,
  Title: DialogTitle,
  Description: DialogDescription,
  Close: DialogClose,
  Trigger: DialogTrigger,
};
