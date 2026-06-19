"use client";

import { type ReactNode, memo } from "react";
import {
  Renderer,
  type ComponentRenderer,
  type Spec,
  StateProvider,
  VisibilityProvider,
  ActionProvider,
} from "@json-render/react";

import { manualRegistry } from "./registry";


// =============================================================================
// ExplorerRenderer
// =============================================================================

interface ExplorerRendererProps {
  spec: Spec | null;
  loading?: boolean;
  bindings?: Record<string, any>;
}

const Fallback = ({ element }: any) => (
  <div className="p-4 border border-dashed rounded-lg text-muted-foreground text-sm uppercase tracking-widest text-center">
    Unknown Component: {element?.type}
  </div>
);

export const ExplorerRenderer = memo(({
  spec: incomingSpec,
  loading,
  bindings,
}: ExplorerRendererProps): ReactNode => {
  // 1. Detect and extract root from Page-level spec (ViewSpec)
  let spec = incomingSpec;
  if (spec && (spec as any).root && (spec as any).elements) {
    const rootKey = (spec as any).root;
    const rootElement = (spec as any).elements[rootKey];
    if (rootElement) {
      console.log("DEBUG [ExplorerRenderer] Extracted root element:", rootKey);
      spec = rootElement;
    }
  }

  if (spec) {
    console.log("DEBUG [ExplorerRenderer] Processing spec type:", (spec as any).type);
  }

  if (!spec || typeof spec !== "object") {
    return (
      <div className="p-4 border border-dashed border-amber-500/50 rounded-lg bg-amber-500/5 text-amber-600 text-xs text-center italic">
        {loading ? "AI가 설계를 준비 중입니다..." : "데이터가 없거나 형식이 잘못되었습니다."}
      </div>
    );
  }

  // If it's an array (like a JSON Patch), it's not a valid UI spec
  if (Array.isArray(spec)) {
    return (
      <div className="p-4 border border-destructive/50 rounded-lg bg-destructive/5 text-destructive text-xs">
        <p className="font-bold mb-1">Rendering Error</p>
        <p>사이드바 데이터가 배열 형식입니다. 개별 컴포넌트 객체여야 합니다.</p>
        <pre className="mt-2 p-2 bg-background rounded border text-[10px] overflow-auto max-h-32">
          {JSON.stringify(spec, null, 2)}
        </pre>
      </div>
    );
  }

  // Check if it's a component spec (has a type)
  if (!("type" in spec)) {
    return (
      <div className="p-4 border border-destructive/50 rounded-lg bg-destructive/5 text-destructive text-xs">
        <p className="font-bold mb-1">Invalid Component Spec</p>
        <p>'type' 필드가 누락되었습니다. (자동 추출 실패)</p>
        <pre className="mt-2 p-2 bg-background rounded border text-[10px] overflow-auto max-h-32">
          {JSON.stringify(spec, null, 2)}
        </pre>
      </div>
    );
  }

  const Component = (manualRegistry as any)[(spec as any).type];

  return (
    <StateProvider initialState={(spec as any).state ?? {}}>
      <VisibilityProvider>
        <ActionProvider>
          {Component ? (
            <Component
              props={(spec as any).props ?? spec}
              bindings={{ ...(spec as any).bindings, ...bindings }}
              emit={(eventName: string, eventData?: any) => {
                // Bridge emit events to binding callbacks
                if (eventName === "compareRequested" && bindings?.onCompareRequested) {
                  bindings.onCompareRequested(eventData?.products ?? []);
                } else if (eventName === "press") {
                  bindings?.onPress?.(eventData);
                  bindings?.onClick?.(eventData);
                } else {
                  // Generic fallback: look for "on<EventName>" in bindings
                  const handlerKey = `on${eventName.charAt(0).toUpperCase()}${eventName.slice(1)}`;
                  bindings?.[handlerKey]?.(eventData);
                }
              }}
            >
              {/* Recursively render children if they exist in slots, children array, or props.children */}
              {((spec as any).slots?.default ?? (spec as any).children ?? (spec as any).props?.children)?.map((child: any, i: number) => (
                <ExplorerRenderer key={i} spec={child} loading={loading} bindings={bindings} />
              ))}
            </Component>
          ) : (
            <Fallback element={spec as any} />
          )}
        </ActionProvider>
      </VisibilityProvider>
    </StateProvider>
  );
});
