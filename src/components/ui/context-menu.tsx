import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { Check } from "lucide-react";
import type React from "react";
import { useId } from "react";

import { useModalManager } from "@/features/app/shell/modalManager";
import { cn } from "@/lib/utils";

export const ContextMenu = ({
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) => {
  const id = useId();
  const manager = useModalManager();
  const surfaceId = `context-menu:${id}`;
  return (
    <ContextMenuPrimitive.Root
      {...props}
      onOpenChange={(open) => {
        props.onOpenChange?.(open);
        if (open) manager.open(surfaceId);
        else manager.close(surfaceId);
      }}
    >
      {children}
    </ContextMenuPrimitive.Root>
  );
};
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuContent = ({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      className={cn(
        "z-50 min-w-44 border border-border bg-panel p-1 text-[12px] text-foreground shadow-lg",
        className,
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
);
export const ContextMenuItem = ({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item>) => (
  <ContextMenuPrimitive.Item
    className={cn(
      "flex h-7 cursor-default select-none items-center gap-2 px-2 outline-none hover:bg-muted focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  />
);
export const ContextMenuCheckboxItem = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) => (
  <ContextMenuPrimitive.CheckboxItem
    className={cn(
      "flex h-7 cursor-default select-none items-center gap-2 px-2 outline-none hover:bg-muted focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="w-3 text-center">
      <ContextMenuPrimitive.ItemIndicator>
        <Check aria-hidden="true" className="size-3" />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.CheckboxItem>
);
export const ContextMenuSeparator = ContextMenuPrimitive.Separator;
