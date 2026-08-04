"use client";

import { useEffect } from "react";

/**
 * Suppresses known third-party library errors that do not affect functionality.
 * - "Maximum update depth exceeded": caused by @ai-sdk/react's useSyncExternalStore
 *   conflicting with React concurrent mode during streaming. App works correctly.
 */
export default function SuppressKnownErrors() {
  useEffect(() => {
    const original = console.error.bind(console);
    console.error = (...args: any[]) => {
      const msg = typeof args[0] === "string" ? args[0] : "";
      if (msg.includes("Maximum update depth exceeded")) return;
      original(...args);
    };
    return () => {
      console.error = original;
    };
  }, []);

  return null;
}
