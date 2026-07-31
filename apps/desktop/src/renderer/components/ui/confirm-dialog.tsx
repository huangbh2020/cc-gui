/**
 * ConfirmDialog - reusable confirmation modal built on the Dialog primitive.
 *
 * Replaces native `confirm()` calls with an in-app dialog. The dialog is
 * controlled (`open` + `onOpenChange`) so callers manage the pending state.
 * Use `danger` to render the confirm button with the destructive variant.
 *
 * @example
 *   <ConfirmDialog
 *     open={pending != null}
 *     title="删除项目"
 *     description="此操作不可恢复。"
 *     confirmText="删除"
 *     danger
 *     onOpenChange={(open) => { if (!open) setPending(null); }}
 *     onConfirm={() => { void remove(); }}
 *   />
 */
import { IconAlertTriangle } from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { Button } from "./button.js";
import { Dialog } from "./dialog.js";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** Render the confirm button with the destructive (danger) variant. */
  danger?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[360px] max-w-[90vw] p-4">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                danger ? "bg-danger/10 text-danger" : "bg-accent/10 text-accent",
              )}
            >
              <IconAlertTriangle size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description className="mt-1">{description}</Dialog.Description>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {cancelText}
            </Button>
            <Button
              variant={danger ? "danger" : "primary"}
              size="sm"
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              {confirmText}
            </Button>
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
