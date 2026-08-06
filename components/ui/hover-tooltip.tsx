"use client";

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Side = "top" | "bottom" | "left" | "right";

const GAP = 10;

const ARROW_POSITION: Record<Side, string> = {
  right: "left-[-4px] top-1/2 -translate-y-1/2",
  left: "right-[-4px] top-1/2 -translate-y-1/2",
  top: "bottom-[-4px] left-1/2 -translate-x-1/2",
  bottom: "top-[-4px] left-1/2 -translate-x-1/2",
};

export function HoverTooltip({
  label,
  side = "right",
  className = "",
  children,
}: {
  label: string;
  side?: Side;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; transform: string }>({
    top: 0,
    left: 0,
    transform: "",
  });
  const ref = useRef<HTMLDivElement>(null);

  const updatePosition = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    switch (side) {
      case "right":
        setPos({ top: r.top + r.height / 2, left: r.right + GAP, transform: "translateY(-50%)" });
        break;
      case "left":
        setPos({ top: r.top + r.height / 2, left: r.left - GAP, transform: "translate(-100%, -50%)" });
        break;
      case "top":
        setPos({ top: r.top - GAP, left: r.left + r.width / 2, transform: "translate(-50%, -100%)" });
        break;
      case "bottom":
        setPos({ top: r.bottom + GAP, left: r.left + r.width / 2, transform: "translateX(-50%)" });
        break;
    }
  };

  return (
    <div
      ref={ref}
      className={`inline-flex ${className}`}
      onMouseEnter={() => {
        updatePosition();
        setOpen(true);
      }}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="tooltip"
            style={{ position: "fixed", top: pos.top, left: pos.left, transform: pos.transform, zIndex: 9999, backgroundColor: "#222222" }}
            className="pointer-events-none whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium text-white shadow-lg"
          >
            {label}
            <span
              className={`absolute w-2 h-2 rotate-45 ${ARROW_POSITION[side]}`}
              style={{ backgroundColor: "#222222" }}
            />
          </div>,
          document.body
        )}
    </div>
  );
}
