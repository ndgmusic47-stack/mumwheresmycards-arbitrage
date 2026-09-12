import { useEffect, useMemo, useState } from "react";
import { blankMoney as blank, applyAmountEdit, buildDealInputs } from "../state/dealForm";
import {
  fetchDeal,
  saveDeal,
  placeDealOffer,
  resolveDealOffer,
  recordDealPurchase,
  type DealBundle,
  type DealCalculation,
  type DealGraderScale,
  type MoneyInput,
} from "../api/client";

/**
 * THE PER-CARD DEAL DESK.
 *
 * The operator's own assumptions for ONE listing, saved, and the resulting
 * costs and profit by outcome.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CUT BACK HARD, 2026-09-12, at the operator's request ("over engineered").
 *
 * It had thirteen money fields and each one carried three controls — an
 * amount, a currency picker and a "where did this number come from" picker —
 * so about forty controls, plus grader, service tier, batch size, an
 * upcharge-applies-to checkbox per grade, a valuation source, a valuation
 * date and a foreign-market flag. For a UK buyer paying in pounds for a £30
 * card, most of that was ceremony standing between him and the four numbers
 * that decide the trade.
 *
 * WHAT WENT: every currency picker (everything is £ — enter the converted
 * figure if you ever buy in dollars), every provenance picker, import charges
 * as a field of its own, return postage, batch insurance, batch size,
 * consumables, the declared-value upcharge and its per-grade checkboxes,
 * packaging, sale insurance, valuation source and date, and the foreign-comp
 * checkbox.
 *
 * WHAT REPLACED THE MISSING CONTROLS, rather than being lost:
 *   - PROVENANCE IS DERIVED. Type a figure and it is your estimate; leave it
 *     blank and it is not known; take a market reference and it is marked as
 *     the provider's. Those were the only three answers ever given, and the
 *     dropdown was asking a question the act of typing already answered.
 *   - BATCH COSTS ARE ENTERED AS YOUR SHARE. Rather than a batch total and a
 *     divisor, one box: what the postage costs you per card. Same arithmetic,
 *     one field instead of four, and — unlike charging the whole batch to
 *     every card — it does not overstate the cost.
 *   - THE FOREIGN-COMP WARNING IS AUTOMATIC. Provider figures are US-market;
 *     taking one still marks the line PROVIDER and the caption still says so.
 *     It never needed a checkbox, because the app already knows.
 *
 * WHAT WAS NOT TOUCHED: the calculator. Not one figure is computed
 * differently. The fields no longer shown are ABSENT from the payload, not
 * blank and not zero — see the note in packages/core's buildAcquisition for
 * why that distinction had to exist before this simplification was safe.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 *  - It never computes a figure in the browser. Every number displayed came
 *    back from the worker, which recomputed it from the saved inputs. A
 *    client-side total would be a second implementation of the economics and
 *    the two would eventually disagree.
 *  - It never predicts a grade. Each row answers a conditional question —
 *    "if it comes back at this grade and sells for this, the profit is
 *    this". Nothing here estimates how likely that grade is, because this
 *    system has no grading-probability data and inventing one would be the
 *    most dangerous possible number to put on screen.
 *  - Selecting a grader changes which OUTCOMES can be priced. It never fills
 *    in a fee. Fees differ by country, tier, declared value and date; the
 *    operator's own invoice is the only source for theirs.
 */

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(n);
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`);

/**
 * Folds several old fields into one, for a deal saved before the desk was cut
 * back. Blank inputs are ignored rather than counted as zero — if every part
 * was blank the result is still blank, because "I never knew these" does not
 * add up to "they cost nothing".
 */
function sumMoney(...parts: (MoneyInput | null | undefined)[]): MoneyInput {
  const known = parts.filter((p): p is MoneyInput => typeof p?.amount === "number" && Number.isFinite(p.amount));
  if (known.length === 0) return blank();
  const total = Math.round(known.reduce((sum, p) => sum + (p.amount as number), 0) * 100) / 100;
  // CONFIRMED only survives if every part was confirmed; otherwise the sum is
  // no stronger than its weakest part.
  const provenance = known.every((p) => p.provenance === "CONFIRMED") ? "CONFIRMED" : "ESTIMATE";
  return { amount: total, currency: "GBP", provenance };
}

/** The old batch total(s) expressed as this one card's share. */
function perCardShare(batchSize: unknown, parts: (MoneyInput | null | undefined)[]): MoneyInput {
  const total = sumMoney(...parts);
  if (total.amount === null) return total;
  const size = typeof batchSize === "number" && Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 1;
  return { ...total, amount: Math.round((total.amount / size) * 100) / 100 };
}

/**
 * One money box. Blank means not known — never zero — and typing a figure
 * makes it yours; both rules live in ../state/dealForm where they are tested.
 */
function MoneyField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: MoneyInput;
  onChange: (next: MoneyInput) => void;
}) {
  return (
    <label className="deal-field" title={hint}>
      <span className="deal-field-label">{label}</span>
      <span className="deal-field-row">
        <span className="deal-currency-prefix">£</span>
        <input
          type="number"
          step="0.01"
          min="0"
          placeholder="blank = not known"
          value={value.amount ?? ""}
          onChange={(e) => onChange(applyAmountEdit(value, e.target.value))}
        />
      </span>
      {hint && <span className="deal-field-hint">{hint}</span>}
    </label>
  );
}

function CostTable({ title, lines, total }: { title: string; lines: DealCalculation["acquisition"]["lines"]; total: number }) {
  if (lines.length === 0) return null;
  return (
    <div className="deal-costs">
      <h4>{title}</h4>
      <table className="deal-cost-table">
        <tbody>
          {lines.map((l) => (
            <tr key={l.key} className={l.detail.missing ? "deal-line-missing" : undefined}>
              <td>
                {l.label}
                {/* A batch of one is not an allocation, so it is not narrated
                    as one. Older deals saved with a real batch still show it. */}
                {l.allocation && l.allocation.batchSize > 1 && (
                  <span className="deal-allocation">
                    {" "}
                    — {money(l.allocation.batchTotalGbp)} ÷ {l.allocation.batchSize}
                    {l.allocation.isActual ? " (actual batch)" : " (planned batch)"}
                  </span>
                )}
                {l.detail.originalCurrency !== "GBP" && !l.detail.missing && (
                  <span className="deal-fx">
                    {" "}
                    — {l.detail.originalAmount} {l.detail.originalCurrency} @ {l.detail.rateToGbp}
                  </span>
                )}
              </td>
              <td className="deal-provenance">{l.detail.missing ? "not known" : l.detail.provenance.toLowerCase()}</td>
              <td className="deal-amount">{l.detail.missing ? "—" : money(l.gbp)}</td>
            </tr>
          ))}
          <tr className="deal-total-row">
            <td colSpan={2}>Total</td>
            <td className="deal-amount">{money(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function DealDesk({ opportunityId, strategy }: { opportunityId: string; strategy: "FLIP" | "GRADE" }) {
  const [bundle, setBundle] = useState<DealBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Inputs, held locally until explicitly saved — the same discipline as the
  // review panel: no network call per keystroke, and a clear "did this
  // persist" moment.
  const [price, setPrice] = useState<MoneyInput>(blank());
  const [sellerPostage, setSellerPostage] = useState<MoneyInput>(blank());
  const [otherCosts, setOtherCosts] = useState<MoneyInput>(blank());

  const [graderId, setGraderId] = useState("PSA");
  const [serviceFee, setServiceFee] = useState<MoneyInput>(blank());
  // Your SHARE of the postage, per card — not a batch total needing a divisor.
  const [gradingPostage, setGradingPostage] = useState<MoneyInput>(blank());

  const [buyerPaidShipping, setBuyerPaidShipping] = useState<MoneyInput>(blank());
  const [outboundPostage, setOutboundPostage] = useState<MoneyInput>(blank());

  const [resale, setResale] = useState<Record<string, MoneyInput>>({});

  const [offerAmount, setOfferAmount] = useState("");

  useEffect(() => {
    fetchDeal(opportunityId)
      .then((b) => {
        setBundle(b);
        if (b.deal) {
          try {
            const saved = JSON.parse(b.deal.inputs_json);
            setPrice(saved.acquisition?.price ?? blank());
            setSellerPostage(saved.acquisition?.sellerPostage ?? blank());
            /*
             * A deal saved by the OLD desk kept import charges and other costs
             * apart, and split grading postage into a batch total plus a
             * divisor. Those figures are real money the operator entered, so
             * they are folded forward rather than dropped: the two acquisition
             * extras are added together, and the batch lines are collapsed to
             * this card's actual share. The arithmetic is the same arithmetic
             * the calculator was already doing — nothing is invented, and a
             * figure that was blank stays blank.
             */
            setOtherCosts(sumMoney(saved.acquisition?.otherAcquisitionCosts, saved.acquisition?.importCharges));
            if (saved.grading) {
              setGraderId(saved.grading.graderId ?? "PSA");
              setServiceFee(saved.grading.serviceFee ?? blank());
              setGradingPostage(
                perCardShare(saved.grading.batchSize, [
                  saved.grading.submissionPostage,
                  saved.grading.returnPostage,
                  saved.grading.batchInsurance,
                  saved.grading.consumablesPerCard,
                ]),
              );
            }
            setBuyerPaidShipping(saved.sale?.buyerPaidShipping ?? blank());
            setOutboundPostage(sumMoney(saved.sale?.outboundPostage, saved.sale?.packaging, saved.sale?.saleInsurance));
            const byGrade: Record<string, MoneyInput> = {};
            for (const entry of saved.resale ?? []) byGrade[entry.gradeKey ?? "RAW"] = entry.value;
            setResale(byGrade);
          } catch {
            setError("This deal's saved inputs could not be read.");
          }
        }
      })
      .catch((e) => setError(String(e)));
  }, [opportunityId]);

  const scale: DealGraderScale | null = useMemo(
    () => (bundle ? (bundle.graderScales[graderId] ?? null) : null),
    [bundle, graderId],
  );

  /*
   * WHICH OUTCOMES TO PRICE.
   *
   * Was "grade 6 and above", on the reasoning that pricing all twenty CGC
   * rungs is noise. That reasoning held while nothing could price a low
   * grade anyway. It no longer does: the market provider returns PSA 3, 4
   * and 5 (and SGC/TAG equivalents), and on a small bankroll the question
   * "does this still pay if it comes back a 5" decides whether a purchase is
   * survivable at all.
   *
   * So a rung is priced when it is 6 or better, OR the provider has a real
   * price for it, OR the operator has already typed one. Low grades appear
   * only when there is something real to put against them, which keeps a
   * twenty-rung CGC ladder from filling with blanks.
   */
  const providerPrices = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of bundle?.gradedPriceReference?.priced ?? []) map.set(entry.gradeKey, entry.gbp);
    return map;
  }, [bundle]);

  const pricedRungs = useMemo(() => {
    if (!scale) return [];
    return scale.rungs.filter(
      (r) => r.value >= 6 || providerPrices.has(r.key) || resale[r.key]?.amount !== null && resale[r.key]?.amount !== undefined,
    );
  }, [scale, providerPrices, resale]);

  function buildInputs() {
    return buildDealInputs(
      {
        strategy,
        // Only what the desk actually asks about. Everything else is ABSENT
        // from the payload — not blank, not zero. See the header note.
        acquisition: { price, sellerPostage, otherAcquisitionCosts: otherCosts },
        grading: {
          graderId,
          serviceFee,
          submissionPostage: gradingPostage,
          // Already this card's share, so there is nothing left to divide.
          batchSize: 1,
        },
        sale: { buyerPaidShipping, outboundPostage },
        resaleByGrade: resale,
      },
      strategy === "GRADE" ? pricedRungs : [],
    );
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await saveDeal(opportunityId, buildInputs());
      setBundle((prev) => (prev ? { ...prev, deal: result.deal, calculation: result.calculation, calculationError: null } : prev));
      setNotice("Saved.");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handlePlaceOffer() {
    if (!bundle?.deal) return;
    const amount = Number(offerAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      setError("Enter a valid offer amount.");
      return;
    }
    try {
      const result = await placeDealOffer(bundle.deal.id, { amount, currency: "GBP" });
      setBundle((prev) => (prev ? { ...prev, offers: result.offers } : prev));
      setOfferAmount("");
      setNotice(result.supersededId ? "Offer revised — the previous one is kept in the history." : "Offer recorded as pending.");
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleResolve(offerId: string, status: "ACCEPTED" | "REJECTED" | "EXPIRED" | "WITHDRAWN") {
    try {
      await resolveDealOffer(offerId, status);
      setBundle(await fetchDeal(opportunityId));
      setNotice(`Offer marked ${status.toLowerCase()}.`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handlePurchase() {
    if (!bundle?.deal) return;
    try {
      const result = await recordDealPurchase(bundle.deal.id);
      setBundle(await fetchDeal(opportunityId));
      setNotice(`Purchase recorded. Inventory ${result.inventoryId.slice(0, 8)}… created; your assumptions are frozen against it.`);
    } catch (e) {
      setError(String(e));
    }
  }

  if (error && !bundle) return <p className="error-banner">{error}</p>;
  if (!bundle) return <p className="empty-state small">Loading deal…</p>;

  const calc = bundle.calculation;
  const pendingOffer = bundle.offers.find((o) => o.status === "PENDING") ?? null;
  // Saving with unknowns is normal — that is how a deal gets worked. Recording
  // the purchase is not: it asserts money actually spent, so the server
  // refuses it while any acquisition cost is blank. Surfaced here so the
  // button explains itself rather than failing on click.
  const missingAcquisition = (calc?.acquisition.lines ?? []).filter((l) => l.detail.missing).map((l) => l.label);

  return (
    <section className="panel deal-desk">
      <h2>Deal calculator</h2>
      <p className="panel-caption">
        Your numbers, in pounds. Leave a box blank if you don&apos;t know it yet — it will be listed as missing rather
        than counted as nothing. Every figure below is recalculated by the server from exactly what you type, and no
        grade is predicted.
      </p>

      {error && <p className="error-banner">{error}</p>}
      {notice && <p className="result-count">{notice}</p>}
      {bundle.calculationError && <p className="error-banner">Saved inputs do not currently calculate: {bundle.calculationError}</p>}

      <h3>What it costs to get</h3>
      <div className="deal-grid">
        <MoneyField label="Price paid" value={price} onChange={setPrice} />
        <MoneyField label="Postage from seller" value={sellerPostage} onChange={setSellerPostage} />
        <MoneyField
          label="Anything else"
          hint="Import duty or VAT, payment fees, fuel — whatever else it took to get the card in your hand."
          value={otherCosts}
          onChange={setOtherCosts}
        />
      </div>

      {strategy === "GRADE" && (
        <>
          <h3>What grading costs</h3>
          <div className="deal-grid">
            <label className="deal-field">
              <span className="deal-field-label">Grader</span>
              <select value={graderId} onChange={(e) => setGraderId(e.target.value)}>
                {Object.entries(bundle.graderScales).map(([id, s]) => (
                  <option key={id} value={id}>
                    {s.graderName}
                  </option>
                ))}
              </select>
            </label>
            <MoneyField label="Grading fee (this card)" value={serviceFee} onChange={setServiceFee} />
            <MoneyField
              label="Postage & insurance (your share)"
              hint="What sending and getting this ONE card back costs you. If you send ten in a batch, that's the batch cost divided by ten."
              value={gradingPostage}
              onChange={setGradingPostage}
            />
          </div>
        </>
      )}

      <h3>What it sells for</h3>
      {bundle.gradedPriceReferenceError && <p className="notice-amber">{bundle.gradedPriceReferenceError}</p>}
      {bundle.gradedPriceReference && (
        <p className="panel-caption">
          Market reference available for {bundle.gradedPriceReference.gradersAvailable.join(", ")}
          {bundle.gradedPriceReference.capturedAt &&
            ` · captured ${new Date(bundle.gradedPriceReference.capturedAt).toLocaleDateString("en-GB")}`}
          . US-market figures converted into pounds — a starting point, not UK sold evidence. Taking one marks the line
          as the provider&apos;s, never as your own comp.
        </p>
      )}
      <div className="deal-grid">
        {strategy === "GRADE" && scale ? (
          pricedRungs.map((r) => (
            <div key={r.key} className="deal-resale-row">
              <MoneyField
                label={r.label}
                value={resale[r.key] ?? blank()}
                onChange={(next) => setResale((prev) => ({ ...prev, [r.key]: next }))}
              />
              {providerPrices.has(r.key) && (
                <button
                  type="button"
                  className="deal-ref-chip"
                  title="The market provider's figure for this grade. US-market data converted to GBP — a reference, not your own UK comp. Click to use it."
                  onClick={() =>
                    setResale((prev) => ({
                      ...prev,
                      // PROVIDER, never CONFIRMED: taking the reference does
                      // not turn it into evidence the operator gathered.
                      [r.key]: { amount: providerPrices.get(r.key)!, currency: "GBP", provenance: "PROVIDER" },
                    }))
                  }
                >
                  ref {money(providerPrices.get(r.key)!)}
                </button>
              )}
            </div>
          ))
        ) : (
          <MoneyField
            label="Sale price"
            value={resale.RAW ?? blank()}
            onChange={(next) => setResale((prev) => ({ ...prev, RAW: next }))}
          />
        )}
        <MoneyField label="Postage the buyer pays" value={buyerPaidShipping} onChange={setBuyerPaidShipping} />
        <MoneyField
          label="Postage & packaging (your cost)"
          hint="What it costs you to send it — postage, mailer, insurance."
          value={outboundPostage}
          onChange={setOutboundPostage}
        />
      </div>

      <div className="deal-actions">
        <button onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save assumptions"}
        </button>
        {scale && (
          <span className="panel-caption">
            Outcomes priced on {scale.graderName}&apos;s own published scale (
            <a href={scale.scaleSourceUrl} target="_blank" rel="noreferrer noopener">
              source
            </a>
            ). Selecting a grader never fills in its fees — those are yours to enter.
          </span>
        )}
      </div>

      {calc && (
        <>
          <h3>Costs</h3>
          <CostTable title="Acquisition" lines={calc.acquisition.lines} total={calc.acquisition.total} />
          {calc.grading.lines.length > 0 && <CostTable title="Grading" lines={calc.grading.lines} total={calc.grading.total} />}
          <p className="result-count">
            Committed before sale: <strong>{money(calc.totalCostBeforeScenario)}</strong>
            {" · "}priced at rates captured {new Date(calc.fx.capturedAt).toLocaleDateString("en-GB")} ({calc.fx.source.toLowerCase()})
          </p>

          {!calc.isComplete && (
            <p className="warn-tag deal-missing">
              Incomplete — these inputs are not known yet, so the figures below are missing a line:{" "}
              {calc.missingInputs.join(", ")}
            </p>
          )}

          <h3>If it sells at…</h3>
          <div className="table-scroll">
            <table className="opp-table">
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th>Total cost</th>
                  <th>Sale value</th>
                  <th>Selling fees</th>
                  <th>Net proceeds</th>
                  <th>Net profit</th>
                  <th>Return on cost</th>
                  <th title="The sale price at which this outcome exactly breaks even under your fee model.">Break-even</th>
                </tr>
              </thead>
              <tbody>
                {calc.scenarios.map((s) => (
                  <tr key={s.gradeKey ?? "RAW"}>
                    <td>
                      {s.gradeLabel}
                      {s.scenarioOnlyCosts.length > 0 && (
                        <div className="warn-tag" title="A cost that only this outcome triggers.">
                          + {s.scenarioOnlyCosts.map((l) => l.label).join(", ")}
                        </div>
                      )}
                      {s.foreignMarketReference && (
                        <div className="hint-tag" title="Converted from a foreign market — not observed UK resale evidence.">
                          foreign reference
                        </div>
                      )}
                    </td>
                    <td>{money(s.totalCost)}</td>
                    <td>{money(s.saleValueGbp)}</td>
                    <td>{money(s.sellingFees)}</td>
                    <td>{money(s.netSaleProceeds)}</td>
                    <td className={s.netProfit === null ? undefined : s.netProfit >= 0 ? "profit-positive" : "profit-negative"}>
                      {money(s.netProfit)}
                    </td>
                    <td>{pct(s.returnOnCost)}</td>
                    <td>{money(s.breakEvenSalePrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="panel-caption">
            Each row is conditional: if it receives that grade and sells for that amount, the profit is that. Nothing here
            estimates how likely any grade is.
          </p>
        </>
      )}

      {bundle.deal && (
        <>
          <h3>Offer out</h3>
          {bundle.purchasedInventoryId ? (
            <p className="result-count">Already purchased — this deal is recorded in inventory and its assumptions are frozen.</p>
          ) : (
            <>
              <div className="deal-grid">
                <label className="deal-field">
                  <span className="deal-field-label">Offer amount</span>
                  <span className="deal-field-row">
                    <span className="deal-currency-prefix">£</span>
                    <input type="number" step="0.01" min="0" value={offerAmount} onChange={(e) => setOfferAmount(e.target.value)} />
                  </span>
                </label>
                <div className="deal-actions">
                  <button onClick={handlePlaceOffer}>{pendingOffer ? "Revise it" : "Record this offer"}</button>
                  {/* Two outcomes, not four. Expired and withdrawn are still
                      valid statuses in the data and older offers keep them —
                      but on screen the only thing that changes what happens
                      next is whether the offer won. */}
                  {pendingOffer && (
                    <>
                      <button onClick={() => handleResolve(pendingOffer.id, "ACCEPTED")}>They accepted</button>
                      <button onClick={() => handleResolve(pendingOffer.id, "REJECTED")}>It didn&apos;t happen</button>
                    </>
                  )}
                </div>
              </div>
              <p className="panel-caption">
                Optional — only worth recording if you want the amount counted in Potential acquisition spend on the
                Pipeline. It is not money spent.
              </p>
              {bundle.offers.length > 0 && (
                <table className="deal-cost-table">
                  <tbody>
                    {bundle.offers.map((o) => (
                      <tr key={o.id}>
                        <td>{new Date(o.placed_at).toLocaleString("en-GB")}</td>
                        <td>{money(o.amount_gbp)}</td>
                        <td>{o.status.toLowerCase()}</td>
                        <td>{o.supersedes_id ? "revised" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {bundle.offers.some((o) => o.status === "ACCEPTED") && (
                <div className="deal-actions">
                  <button onClick={handlePurchase} disabled={missingAcquisition.length > 0}>
                    Record the purchase
                  </button>
                  <span className="panel-caption">
                    {missingAcquisition.length > 0 ? (
                      <>
                        Recording a purchase states that this money left your account, so every acquisition cost has to
                        be known first. Still blank: {missingAcquisition.join(", ")}. If there genuinely was no such
                        cost, enter 0.
                      </>
                    ) : (
                      <>Creates one inventory record and freezes these assumptions against it. It cannot be done twice.</>
                    )}
                  </span>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
