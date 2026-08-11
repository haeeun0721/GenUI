/**
 * Request-scoped context store for the baseline chat route.
 * Baseline has no generated UI surfaces (no side panel / comp table / option
 * list / mutate-surface stores) — just the plain per-request fields the chat
 * agent and its tools need.
 */

/** The active request ID – set on every incoming POST before the agent runs. */
export let currentRequestId = "";
export function setCurrentRequestId(id: string) {
  currentRequestId = id;
}

/** The user context collected from onboarding – used for grounding the assistant's persona. */
export let currentUserContext = "";
export function setCurrentUserContext(ctx: string) {
  currentUserContext = ctx;
}

/** Product category from onboarding (e.g. "로봇 청소기", "카메라") — used by the search tool and persona. */
export let currentProductCategory: string = "";
export function setCurrentProductCategory(category: string) {
  currentProductCategory = category;
}

/** Response language locale — set from request cookie "gs_locale". Default: "ko". */
export let currentLocale: "ko" | "en" = "ko";
export function setCurrentLocale(locale: "ko" | "en") {
  currentLocale = locale;
}
