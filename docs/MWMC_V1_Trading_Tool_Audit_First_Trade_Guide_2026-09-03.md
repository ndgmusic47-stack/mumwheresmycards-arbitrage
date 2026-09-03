# MWMC V1 Trading Tool Audit & First Trade Operating Guide

**Audit snapshot:** 3 September 2026  
**Purpose:** Make the first real trade safely, then learn from realised results.

## Executive conclusion

You have a usable sourcing scanner now. You do not yet have a trustworthy autonomous trading system.

The strongest workflow is:

**PokeTrace market data -> deterministic economics -> live eBay discovery -> shortlist -> human verification -> purchase -> realised outcome tracking.**

Use the machine to find candidates quickly. Use your own eyes and a final UK sold-comps check to establish the trade you are actually willing to fund.

## How I would make trade #1

Before scanning, change the actual runtime FLIP mandate so the engine is suitable for a roughly £200 starting bankroll. The existing default of £40 minimum net profit and 40% ROC can exclude smaller but valid early trades upstream, because those thresholds also help determine the maximum eBay acquisition price worth searching.

| First-trade mandate | Suggested setting |
|---|---:|
| Minimum net profit | £10 |
| Minimum ROC | 30% |
| Maximum delivered acquisition | £40 |
| Minimum QSV | £15 |
| Minimum liquidity | Medium |
| Minimum confidence | 60% |
| Maximum expected sale time | 30 days |

Then:

1. Open **Flips**, not Grade. Run a fresh scan. Prove the raw-flip workflow before tying capital up in grading.
2. In **Actionable**, cap delivered acquisition around £40, require at least Medium liquidity and about 60% confidence, then sort by **Discount to QSV** with the largest discounts first.
3. Prefer a simple UK Buy It Now / fixed-price raw English card for trade #1. Avoid auctions and overseas complexity initially.
4. Open the opportunity and verify the exact card: set, number, language, variant and finish against the real eBay listing and photos.
5. Inspect condition yourself. The main raw QSV is primarily based on the Near Mint pricing tier, so whitening, dents, scratches or other defects can invalidate the headline number.
6. Manually check recent UK eBay sold/completed listings for the exact printing and similar condition. Exclude slabs, bundles, wrong variants and obvious bad matches.
7. Use the lower, more conservative answer between your manual UK QSV and the tool QSV. For early trades, only buy when delivered acquisition is roughly **50-60% of that conservative QSV**, preferably nearer 50-55% when condition is uncertain.
8. Keep first-card exposure around **£30-40**. The goal is proving that a small amount of capital can be recycled into more cash quickly.
9. Mark promising listings **INTERESTED** while checking them. If purchased, record the actual purchase separately; do not assume the review status alone creates a full inventory transaction.
10. List quickly and record actual sale price, fees, postage, packaging, net profit and days held. The experiment is whether the predicted value converts into real cash.

## What the tool actually does in plain English

The engine first asks which Pokémon cards are economically worth looking at. It uses PokeTrace market data to build a dynamic universe, calculates a conservative quick-sale reference and a maximum acquisition price, then spends limited eBay API calls only on cards worth checking.

When eBay returns a real listing, the deterministic engine calculates delivered acquisition cost, QSV, net sale proceeds, net profit, ROC and time-related metrics. It then applies identity, listing-structure, condition and data-quality guardrails. Promising listings can receive deeper eBay enrichment and AI review.

A scan is **not the entire eBay Pokémon market**. "No opportunity shown" does not mean no opportunity exists. "Opportunity shown" means the listing deserves investigation.

## What is strong enough to use now

| Component | Assessment |
|---|---|
| Catalogue + market profiling | Strong - use it |
| PokeTrace integration | Usable - verify valuable trades |
| QSV arithmetic | Strong screening reference |
| eBay live discovery | Strong |
| Deterministic flip maths | Strong |
| Auction handling | Good, but avoid trade #1 |
| Pagination / filters / sorting | Good |
| Opportunity detail | Good |
| Manual review workflow | Good |
| Realised reconciliation backend | Good architecture |

## QSV: useful, but not the final truth

The core QSV rule is conservative: **lower of the 7-day and 30-day sold medians, then an 8% quick-sale haircut**. If the provider has only a fallback market reference rather than a sold median, the engine treats that result as low-confidence and does not allow it to qualify a clean flip.

However, the market inputs come from PokeTrace aggregated statistics. MWMC is not independently ingesting every individual UK eBay sold transaction and cleaning those comps itself. The provider adapter also chooses one available price source in priority order rather than building a true multi-source consensus.

Treat the number on screen as a **machine-generated valuation reference**, not independently established UK fair market value for the exact physical copy. A final UK sold-comps check remains part of the trade.

## Liquidity

Current liquidity is a V1 heuristic based on provider sale count:

| Provider sale count | Current label |
|---:|---|
| 40+ | Very High |
| 15-39 | High |
| 5-14 | Medium |
| Below 5 | Low |

This is useful for ranking market depth, but it is not a calibrated probability that your copy will sell within seven days.

## Condition

The system can detect explicit title phrases such as Near Mint, Lightly Played, Moderately Played, Heavily Played and Damaged. It deliberately ignores bare abbreviations such as HP or LP because Pokémon card titles can contain HP as the printed hit-point stat.

PokeTrace also carries separate condition tiers. But the main raw QSV remains Near-Mint-led, and the condition-adjusted references are not yet the same fully conservative sold-median QSV calculation. **Photos remain essential.**

## Card identity

The title reconciliation can reject mismatched card names, explicit contradictory card numbers, wrong-language signals and important variant contradictions such as reverse holo, first edition or shadowless.

Some set/year/rarity information is still carried from the search target because real eBay titles are incomplete. Final verification remains the exact card number, variant, language and photos.

## Slab, lot and condition-dependent routing

The deterministic engine now has explicit review states for already-graded slabs, likely lots/bundles and condition-dependent opportunities. This is a major improvement because raw-card economics are no longer silently trusted when the listing structure is clearly wrong.

### Current UI issue: Review does not include all review states

The core engine has multiple review-style states, but the current dashboard Review category maps only to `INSPECT_PHOTOS`. `REVIEW_ALREADY_GRADED`, `REVIEW_LIKELY_LOT` and `REVIEW_CONDITION_DEPENDENT` are not included in that queue. They can still exist in All, but the Review tab is incomplete and should be corrected.

## AI

The on-demand listing analyst is potentially useful because it can inspect listing photos, description, condition text, item specifics, seller evidence, identity, item type, language, visible damage, photo quality and why a listing may be cheap. The financial calculations remain deterministic rather than being generated by the language model.

Best use:

> You already found a £28 card with a £55 machine reference. Ask the AI to inspect the evidence and tell you what you may have missed.

Do **not** use the AI as the source of QSV or as an autonomous buyer.

### Known automatic AI sequencing problem

The current configuration can allow more automatic AI candidate reviews than deep eBay enrichments in a scan. That creates a path where a candidate can be AI-reviewed before the richer evidence is definitely present, then not automatically re-reviewed later. Until that is fixed and live-tested, automatic AI routing should not be important to the first purchase decision.

### AI visibility issue

AI can store `PASS_THROUGH`, `REVIEW` or `BLOCK_FROM_ACTIONABLE` opinions. A server-side block can remove a row from normal Actionable results, but the current dashboard does not provide a strong dedicated AI-flagged review queue. Early on, you need to see what the AI rejected so you can measure whether it is saving you from bad trades or throwing away good ones.

### Live AI cannot be proven from source alone

The repository contains the OpenAI integration and smoke-test tooling, but source code cannot prove that the actual production key and chosen models have all passed on the live account. Treat live smoke-test output as the acceptance evidence.

## Natural-language search

The natural-language box is a translator from a sentence into a fixed set of dashboard filters. It is intentionally told not to invent thresholds you did not state.

Good:

> Show flips over £12 profit, 30% ROC, under £40 acquisition.

Bad for the current implementation:

> Make the filters less harsh.

Also distinguish **view filters** from **runtime engine settings**. Dashboard filters change what existing candidates you see. Runtime qualification rules and the eBay search ceiling live in settings.

## Grading

The grading side has a strong payoff calculator: basis, PSA 6-10 ladder, break-even grade, grading fees, batch logistics, upcharge risk, capital lock and required PSA10 hit rate.

What it does not have is a validated probability that a specific raw card will grade PSA 10. There is currently no historical gem-rate input in the PokeTrace adapter.

Therefore GRADE should be treated as **candidate discovery and payoff analysis, not a grade predictor**. With a £200 bankroll, prove several raw flips before tying up capital for grading.

## Financial model

The V1 exit model is eBay UK business-seller economics, including final-value fee, regulatory operating fee, per-order fee, VAT on seller fees and optional promotion/international charges. Selling costs such as outbound postage and packaging are explicit settings. Grading fees and batch logistics are also explicit.

Important practical gaps remain: real scanner listings do not automatically populate every import-tax or acquisition-fee field, and FX is a configured/static conversion rather than a live hedge. For first trades, favour **UK domestic inventory** and keep the transaction simple.

## Inventory and transaction tracking

The backend is well designed for learning. When a purchase is formally recorded against an opportunity, it freezes the forecast as it existed when money was committed. Later, a sale can store actual sale price, marketplace fees, postage, insurance, packaging, real profit, ROC and days held. Reconciliation can compare forecast versus realised.

The operational frontend is not fully finished. Inventory and Pipeline are mostly read-oriented, and marking an opportunity BOUGHT does not by itself create the same full purchase record as the inventory API. For the first handful of trades, it is acceptable to keep the realised trade log in the existing spreadsheet rather than start another build cycle.

## Market page

Market is a research terminal for the whole profiled catalogue, independent of current eBay supply. It is useful for understanding what card types the engine likes and how raw/PSA/liquidity/confidence filters behave.

It is not the main daily buying screen. **Flips is the trading desk.**

## Deployment and release cautions

The checked-in production Worker configuration still contains placeholder production values that must be replaced before deployment. Also, a root package build is not the same as proving the React web application built; the web app has its own build command. Treat real deployment smoke tests as separate acceptance evidence.

## Audit scorecard

| Area | Status |
|---|---|
| Market catalogue | USE IT |
| PokeTrace market data | USE IT; verify valuable trades |
| QSV formula | USE IT as screening reference |
| Automated true FMV | DO NOT ASSUME |
| eBay live opportunity sourcing | USE IT |
| Flip profit maths | USE IT |
| Identity protection | USE IT + verify photos |
| Condition handling | Useful, manual final call |
| Lot/slab protection | Much improved |
| Auction max bid | Useful; avoid trade #1 |
| Dashboard/filter/sort | USE IT |
| Natural-language box | Explicit numeric requests only |
| AI automatic router | Not trusted yet |
| Multimodal listing analyst | Useful second opinion if live |
| Grading economics | Useful research; not grade prediction |
| Inventory backend | Good |
| Inventory operational UI | Incomplete |
| Transactions backend | Good |
| Sale-entry UI | Incomplete |
| Reconciliation | Good once trades recorded |
| Runtime settings | Good backend; no full settings UI |
| Production deployment | Needs real config + smoke test |

## What I would do next - and then stop building

1. Fix the enrichment-before-automatic-AI-review sequencing issue.
2. Make the Review queue include all deterministic review states, and make AI REVIEW/BLOCK candidates visible for audit.
3. Set the actual runtime FLIP mandate for the £200 bankroll.

Then stop adding theory and features. **Use the scanner.**

The first meaningful experiment is:

> Can we inspect 20-30 machine-surfaced leads and find one genuine card we can buy around £20-35, independently validate around £40-60 QSV, resell promptly, and turn back into more cash?

If yes, repeat it.

After 20-30 actual flips you will know whether PokeTrace QSV tends to run high or low, which cards create false positives, the real fees and postage, actual days held, how often condition kills a trade, and whether the scanner is producing a genuine sourcing edge.

## Operating principle

Treat the tool as a **very fast lead-generation and financial-screening terminal with a human making the final £ decision**. That is enough to start testing the business now.

---

**Reference note:** This document is a snapshot of the repo audit and recommended operating method as of 3 September 2026. Re-check the live repo and runtime before treating any implementation detail as current after later commits.
