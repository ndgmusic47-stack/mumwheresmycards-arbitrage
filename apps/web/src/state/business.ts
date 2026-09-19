/**
 * WHAT BUSINESS THIS TOOL IS FOR.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FLIP IS OFF. The operator, repeatedly, and then once more after finding
 * it still on screen: "dont worry about flips just focus on grade park the
 * flip business it dont work we only grade here in our bsuiness", and later
 * "i dont flip this was supposed to be gone".
 *
 * The scanner was changed to match weeks ago — the whole eBay search budget
 * goes to grading candidates. The UI was not. So the operator kept opening
 * a dashboard that LED with a "RAW FLIP" table, offered six flip filters
 * above the grading ones, carried a "Flips" tab in the navigation, and
 * reported "dynamic flip markets" as a headline number. Every screen told
 * him the tool did something he had told it to stop doing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A FLAG RATHER THAN DELETING THE CODE.
 *
 * Deleting would be the more confident-looking change and the wrong one.
 * The flip economics are computed, stored and tested; thousands of flip
 * opportunities already exist in the database; and "parked" is the word he
 * used, not "wrong". Ripping the calculations out would throw away working,
 * verified code to solve a problem that is entirely about what the screen
 * shows.
 *
 * So the engine is untouched and the UI stops offering it. One constant,
 * one place, reversible in a line — and nothing silently deleted from a
 * database on the strength of an interface decision.
 *
 * What this switch does when false:
 *   - no "Flips" tab in the navigation,
 *   - the home dashboard opens on grading candidates instead of everything,
 *   - the flip block disappears from the filter bar,
 *   - flip-only figures disappear from the summary tiles.
 *
 * What it deliberately does NOT do: change any stored row, any computation,
 * or any API. Set it back to true and the flip UI returns exactly as it was.
 */
export const FLIP_ENABLED = false;

/**
 * The strategy the dashboard's main view shows when flip is parked.
 *
 * "ALL" was the old home view and is why the flip table sat above the
 * grading one: ALL means both, and flip sorts first. With flip off, the
 * main view IS the grading view.
 */
export const DEFAULT_STRATEGY_TAB: "ALL" | "GRADE" = FLIP_ENABLED ? "ALL" : "GRADE";
