/**
 * Request-scoped side panel results store.
 * Keyed by a per-request ID so concurrent requests don't interfere.
 */
export const sidePanelStore = new Map<string, any[]>();

/** Call at the start of each request to initialize a slot. */
export function initSidePanelStore(requestId: string) {
  sidePanelStore.set(requestId, []);
}

/** Retrieve and clear the results for a request. */
export function popSidePanelResults(requestId: string): any[] {
  const results = sidePanelStore.get(requestId) ?? [];
  sidePanelStore.delete(requestId);
  return results;
}

/** Called from within the sidebar tool execute to register a result. */
export function pushSidePanelResult(requestId: string, spec: any) {
  const arr = sidePanelStore.get(requestId);
  if (arr) arr.push(spec);
}

// ---------------------------------------------------------------------------
// Chat-UI store (for renderInChat tool — categories 2, 3, 4)
// ---------------------------------------------------------------------------

export const chatUIStore = new Map<string, any[]>();

export function initChatUIStore(requestId: string) {
  chatUIStore.set(requestId, []);
}

export function popChatUIResults(requestId: string): any[] {
  const results = chatUIStore.get(requestId) ?? [];
  chatUIStore.delete(requestId);
  return results;
}

export function pushChatUIResult(requestId: string, spec: any) {
  const arr = chatUIStore.get(requestId);
  if (arr) arr.push(spec);
}

/** The active request ID – set on every incoming POST before agent runs. */
export let currentRequestId = "";
export function setCurrentRequestId(id: string) {
  currentRequestId = id;
}

/** The user context collected from onboarding – passed directly to UI Agent. */
export let currentUserContext = "";
export function setCurrentUserContext(ctx: string) {
  currentUserContext = ctx;
}
