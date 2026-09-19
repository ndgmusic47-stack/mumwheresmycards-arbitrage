import type { ReviewStatus } from "../api/client";

/**
 * WHAT COUNTS AS "ALREADY IN THE PIPELINE", IN ONE PLACE.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BUG. Reported 2026-09-14: "when I moved the card along to under offer
 * stage I see it pop up again in the scan as an option."
 *
 * The working feed excluded exactly one status — PASS. Everything else came
 * back as a fresh candidate, so a card being actively negotiated, or one
 * already bought and paid for, sat in the sourcing list alongside cards
 * never looked at, offering itself again.
 *
 * That is worse than untidy. The whole point of the feed is "things I have
 * not dealt with yet", and a lead that reappears after you have acted on it
 * invites acting on it twice — which, on a card you have already made an
 * offer on, means bidding against yourself.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE DEFINITION LIVES HERE AND NOT IN TWO PLACES. The Pipeline board
 * queries INTERESTED, UNDER_OFFER and BOUGHT; the feed excluded PASS. Two
 * lists, written independently, each half-right, and nothing forcing them to
 * agree — so a status added to one (UNDER_OFFER was added days earlier)
 * silently failed to register with the other. Both now read the same
 * constants: whatever the board claims, the feed hides.
 *
 * CHECKED is deliberately NOT here. It means "I have looked at this", not "I
 * have decided something about it" — there is no Pipeline column for it, so
 * it stays in the feed awaiting an actual decision.
 */

/** The three columns of the sourcing board — see Pipeline.tsx. */
export const PIPELINE_REVIEW_STATUSES: readonly ReviewStatus[] = ["INTERESTED", "UNDER_OFFER", "BOUGHT"];

/**
 * Statuses the working feed must never show: everything on the board, plus
 * the ones explicitly dismissed.
 *
 * A PASSed listing stays gone for good — `upsertOpportunity`'s ON CONFLICT
 * clause never rewrites review_status, so a later scan touching the same
 * listing updates the economics underneath the decision without resetting
 * the decision. Every status here inherits that protection.
 */
export const FEED_HIDDEN_REVIEW_STATUSES: readonly ReviewStatus[] = [...PIPELINE_REVIEW_STATUSES, "PASS"];

/** True when acting on a row should make it leave the feed immediately,
 *  rather than waiting for the next fetch to notice. */
export function leavesTheFeed(status: ReviewStatus): boolean {
  return FEED_HIDDEN_REVIEW_STATUSES.includes(status);
}
