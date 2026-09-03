-- AI INTELLIGENCE gap 3: selective AI review in the candidate pipeline.
--
-- These four columns are the ONLY thing the new AI routing step (see
-- scanRunner.ts's "SELECTIVE AI CANDIDATE REVIEW" step, and
-- AiCandidateRouterProvider in @mwmc/providers) is ever allowed to write.
-- Deliberately separate from, and never overwriting, `state` — the
-- deterministic engine's own qualification column (packages/core's
-- buildOpportunities) is untouched by this feature; AI review is an
-- ADDITIONAL, orthogonal signal layered on top of an already-qualified
-- candidate, not a replacement for how it was qualified. See
-- opportunitiesRepo.ts's applyAiCandidateReview() for the (narrow,
-- UPDATE-only) function that ever writes these.
--
-- ai_review_status: one of PASS_THROUGH / REVIEW / BLOCK_FROM_ACTIONABLE
--   (see CandidateRoute in packages/providers/src/routing/
--   CandidateRouterProvider.ts), or NULL when this candidate has never been
--   through the AI review step (no AI configured, budget-capped this run,
--   or simply not reached yet — NULL is never treated as a block).
-- ai_review_reason: the model's own short, evidence-based explanation for
--   the route it chose — free text, surfaced to a human, never parsed.
-- ai_review_confidence: the model's own 0-1 confidence in that route.
-- ai_reviewed_at: when this row last went through AI review.
ALTER TABLE opportunities ADD COLUMN ai_review_status TEXT;
ALTER TABLE opportunities ADD COLUMN ai_review_reason TEXT;
ALTER TABLE opportunities ADD COLUMN ai_review_confidence REAL;
ALTER TABLE opportunities ADD COLUMN ai_reviewed_at TEXT;
