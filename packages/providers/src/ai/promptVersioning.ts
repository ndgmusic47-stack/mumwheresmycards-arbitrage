import type { AiCompletionRequest } from "./AiModelProvider.js";

/**
 * AI INTELLIGENCE spec Phase 2, Workstream H: prompt versioning.
 *
 * WHY THIS EXISTS: every AI-layer feature (Listing Analyst, financial
 * auditor, natural-language query interpreter, scenario engine — none
 * built yet, this is the shared plumbing they'll all use) constructs its
 * instructions/input from a TEMPLATE, not free-hand per call site. Editing
 * that template later (a wording change, a new example, a tightened
 * schema) can change model behaviour — so every AiCompletionRequest and
 * every cached/stored answer carries a STABLE identifier for exactly which
 * template version produced it (`promptVersionId`, already a field on
 * AiCompletionRequest/AiCompletionResult since Workstream F, and already
 * part of AiCompletionCache's cache key since Workstream G — a v2 template
 * NEVER silently reuses a v1 answer from cache). This file is what makes
 * that id well-formed and consistently derived, rather than a hand-typed
 * string that could drift between call sites.
 *
 * DELIBERATELY NO ACTUAL PROMPT CONTENT LIVES HERE. No AI feature has been
 * built yet (Workstream J/L/M/N are still pending) — this is the shared
 * mechanism those workstreams will define their own PromptTemplate objects
 * against, not a first real prompt. Per the DO-NOT-DO list's "no hidden/
 * silent assumption changes", every future template MUST go through
 * definePromptTemplate() (which validates id/version shape) rather than a
 * raw object literal, so a malformed id/version is caught immediately
 * rather than silently producing an unparseable promptVersionId later.
 */
export interface PromptTemplate<TVars> {
  /** Stable identity — chosen once, never renamed. Renaming an id is
   *  indistinguishable from retiring one template and creating an
   *  unrelated new one (any prior cached/logged answers under the old id
   *  become permanently unassociated with it) — bump `version` instead for
   *  any change to an existing template's behaviour. snake_case,
   *  [a-z][a-z0-9_]*. */
  id: string;
  /** Bumped whenever a change could plausibly change model output —
   *  wording, examples, schema, instructions. A version is never reused
   *  for different content once it has been used to answer any real
   *  request. Starts at 1, integers only. */
  version: number;
  /** Human-readable note on what this template is for / what changed at
   *  this version — shown in any future prompt-audit UI, not sent to the
   *  model. */
  description: string;
  /** Pure: caller-supplied variables in, {instructions, input} out. Must
   *  not perform I/O or depend on ambient state — the whole point of a
   *  template is that the same vars always render the same request. */
  render(vars: TVars): { instructions: string; input: string };
}

const TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Validates and returns a PromptTemplate. Every real template in this
 * codebase should be constructed through this function, never a bare
 * object literal — malformed id/version shapes fail LOUDLY at module-load
 * time (a startup-time error), not silently at the first real AI call.
 */
export function definePromptTemplate<TVars>(template: PromptTemplate<TVars>): PromptTemplate<TVars> {
  if (!TEMPLATE_ID_PATTERN.test(template.id)) {
    throw new Error(
      `Invalid PromptTemplate id "${template.id}" — must be snake_case matching ${TEMPLATE_ID_PATTERN} (e.g. "listing_analyst_routing").`,
    );
  }
  if (!Number.isInteger(template.version) || template.version < 1) {
    throw new Error(`Invalid PromptTemplate version ${template.version} for id "${template.id}" — must be a positive integer.`);
  }
  return Object.freeze({ ...template });
}

/** The exact string stored as `promptVersionId` — e.g. "listing_analyst_routing@v3". */
export function promptVersionId(template: Pick<PromptTemplate<unknown>, "id" | "version">): string {
  return `${template.id}@v${template.version}`;
}

const VERSION_ID_PATTERN = /^([a-z][a-z0-9_]*)@v(\d+)$/;

/**
 * Inverse of promptVersionId() — for reading a stored/logged
 * promptVersionId back apart (e.g. a future audit view grouping review
 * decisions by which prompt version was live when they were made). Returns
 * null for anything not in the expected shape, rather than throwing —
 * older data or a hand-typed id should degrade to "unparseable", never
 * crash a report.
 */
export function parsePromptVersionId(id: string): { templateId: string; version: number } | null {
  const match = VERSION_ID_PATTERN.exec(id);
  if (!match) return null;
  return { templateId: match[1]!, version: Number(match[2]) };
}

/**
 * Renders `template` against `vars` and stamps the result with the
 * template's own promptVersionId — the ONE place instructions/input/
 * promptVersionId get assembled into a request, so a call site can never
 * render a template's text but forget (or hand-type wrong) its version id.
 */
export function buildAiRequest<TVars>(
  template: PromptTemplate<TVars>,
  vars: TVars,
  extra: Omit<AiCompletionRequest, "instructions" | "input" | "promptVersionId">,
): AiCompletionRequest {
  const { instructions, input } = template.render(vars);
  return { ...extra, instructions, input, promptVersionId: promptVersionId(template) };
}
