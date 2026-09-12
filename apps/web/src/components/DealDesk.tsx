import { useEffect, useMemo, useState } from "react";
import {
  blankMoney as blank,
  applyAmountEdit,
  applyProvenanceEdit,
  buildDealInputs,
} from "../state/dealForm";
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
  type MoneyProvenance,
} from "../api/client";

/**
 * THE PER-CARD DEAL DESK.
 *
 * The operator's own assumptions for ONE listing, saved, and the resulting
 * costs and profit by outcome.
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

const CURRENCIES = ["GBP", "USD", "EUR"];
const PROVENANCES: { value: MoneyProvenance; label: string; title: string }[] = [
  { value: "CONFIRMED", label: "Confirmed", title: "A real figure you have — an invoice, a receipt, an agreed price." },
  { value: "ESTIMATE", label: "My estimate", title: "Your own researched figure. Real, but not yet confirmed." },
  { value: "PROVIDER", label: "Provider reference", title: "A number this tool pulled from market data rather than one you supplied." },
  { value: "UNKNOWN", label: "Not known yet", title: "Leave the amount blank. It will be listed as missing rather than counted as zero." },
];

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(n);
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`);

/** One editable money field: amount, currency, and where the number came from. */
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
        <input
          type="number"
          step="0.01"
          min="0"
          placeholder="blank = not known"
          value={value.amount ?? ""}
          // Blank means "not known", never zero; a typed figure is promoted
          // to the operator's own estimate rather than claimed as confirmed.
          // Both rules live in ../state/dealForm, where they are tested.
          onChange={(e) => onChange(applyAmountEdit(value, e.target.value))}
        />
        <select value={value.currency ?? "GBP"} onChange={(e) => onChange({ ...value, currency: e.target.value })}>
          {CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
        <select
          value={value.provenance}
          onChange={(e) => onChange(applyProvenanceEdit(value, e.target.value as MoneyProvenance))}
        >
          {PROVENANCES.map((p) => (
            <option key={p.value} value={p.value} title={p.title}>
              {p.label}
            </option>
          ))}
        </select>
      </span>
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
                {l.allocation && (
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
  const [importCharges, setImportCharges] = useState<MoneyInput>(blank());
  const [otherCosts, setOtherCosts] = useState<MoneyInput>(blank());

  const [graderId, setGraderId] = useState("PSA");
  const [serviceName, setServiceName] = useState("");
  const [serviceFee, setServiceFee] = useState<MoneyInput>(blank());
  const [submissionPostage, setSubmissionPostage] = useState<MoneyInput>(blank());
  const [returnPostage, setReturnPostage] = useState<MoneyInput>(blank());
  const [batchInsurance, setBatchInsurance] = useState<MoneyInput>(blank());
  const [batchSize, setBatchSize] = useState(10);
  const [consumables, setConsumables] = useState<MoneyInput>(blank());
  const [upcharge, setUpcharge] = useState<MoneyInput>(blank());
  const [upchargeGrades, setUpchargeGrades] = useState<string[]>([]);

  const [buyerPaidShipping, setBuyerPaidShipping] = useState<MoneyInput>(blank());
  const [outboundPostage, setOutboundPostage] = useState<MoneyInput>(blank());
  const [packaging, setPackaging] = useState<MoneyInput>(blank());
  const [saleInsurance, setSaleInsurance] = useState<MoneyInput>(blank());

  const [resale, setResale] = useState<Record<string, MoneyInput>>({});
  const [valuationSource, setValuationSource] = useState("");
  const [valuationDate, setValuationDate] = useState("");
  const [foreignReference, setForeignReference] = useState(false);

  const [offerAmount, setOfferAmount] = useState("");
  const [offerCurrency, setOfferCurrency] = useState("GBP");

  useEffect(() => {
    fetchDeal(opportunityId)
      .then((b) => {
        setBundle(b);
        if (b.deal) {
          try {
            const saved = JSON.parse(b.deal.inputs_json);
            setPrice(saved.acquisition?.price ?? blank());
            setSellerPostage(saved.acquisition?.sellerPostage ?? blank());
            setImportCharges(saved.acquisition?.importCharges ?? blank());
            setOtherCosts(saved.acquisition?.otherAcquisitionCosts ?? blank());
            if (saved.grading) {
              setGraderId(saved.grading.graderId ?? "PSA");
              setServiceName(saved.grading.serviceName ?? "");
              setServiceFee(saved.grading.serviceFee ?? blank());
              setSubmissionPostage(saved.grading.submissionPostage ?? blank());
              setReturnPostage(saved.grading.returnPostage ?? blank());
              setBatchInsurance(saved.grading.batchInsurance ?? blank());
              setBatchSize(saved.grading.batchSize ?? 10);
              setConsumables(saved.grading.consumablesPerCard ?? blank());
              setUpcharge(saved.grading.upcharge ?? blank());
              setUpchargeGrades(saved.grading.upchargeAppliesToGradeKeys ?? []);
            }
            setBuyerPaidShipping(saved.sale?.buyerPaidShipping ?? blank());
            setOutboundPostage(saved.sale?.outboundPostage ?? blank());
            setPackaging(saved.sale?.packaging ?? blank());
            setSaleInsurance(saved.sale?.saleInsurance ?? blank());
            const byGrade: Record<string, MoneyInput> = {};
            for (const entry of saved.resale ?? []) byGrade[entry.gradeKey ?? "RAW"] = entry.value;
            setResale(byGrade);
            const first = saved.resale?.[0];
            setValuationSource(first?.valuationSource ?? "");
            setValuationDate(first?.valuationDate ?? "");
            setForeignReference(first?.foreignMarketReference === true);
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
        acquisition: { price, sellerPostage, importCharges, otherAcquisitionCosts: otherCosts },
        grading: {
          graderId,
          serviceName,
          serviceFee,
          submissionPostage,
          returnPostage,
          batchInsurance,
          batchSize,
          consumablesPerCard: consumables,
          upcharge,
          upchargeAppliesToGradeKeys: upchargeGrades,
        },
        sale: { buyerPaidShipping, outboundPostage, packaging, saleInsurance },
        resaleByGrade: resale,
        valuationSource,
        valuationDate,
        foreignMarketReference: foreignReference,
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
      const result = await placeDealOffer(bundle.deal.id, { amount, currency: offerCurrency });
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
        Your own numbers for this card. Every figure below is recalculated by the server from exactly what you enter —
        nothing here is estimated on your behalf, and no grade is predicted.
      </p>

      {error && <p className="error-banner">{error}</p>}
      {notice && <p className="result-count">{notice}</p>}
      {bundle.calculationError && <p className="error-banner">Saved inputs do not currently calculate: {bundle.calculationError}</p>}

      <h3>Acquisition</h3>
      <div className="deal-grid">
        <MoneyField label="Offer / purchase price" value={price} onChange={setPrice} />
        <MoneyField label="Postage from seller" value={sellerPostage} onChange={setSellerPostage} />
        <MoneyField label="Import charges" hint="Duty, import VAT, courier handling." value={importCharges} onChange={setImportCharges} />
        <MoneyField label="Other acquisition costs" value={otherCosts} onChange={setOtherCosts} />
      </div>

      {strategy === "GRADE" && (
        <>
          <h3>Grading</h3>
          <div className="deal-grid">
            <label className="deal-field">
              <span className="deal-field-label">Grader</span>
              <select value={graderId} onChange={(e) => setGraderId(e.target.value)}>
                {Object.values(bundle.graderScales).map((s) => (
                  <option key={s.graderId} value={s.graderId}>
                    {s.graderName}
                  </option>
                ))}
              </select>
            </label>
            <label className="deal-field">
              <span className="deal-field-label">Service / tier</span>
              <input
                type="text"
                placeholder="e.g. Value, Economy"
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
              />
            </label>
            <MoneyField label="Service fee (per card)" hint="What this grader charges YOU at this tier." value={serviceFee} onChange={setServiceFee} />
            <label className="deal-field">
              <span className="deal-field-label">Batch size</span>
              <input type="number" min="1" step="1" value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} />
            </label>
            <MoneyField label="Postage to grader (whole batch)" value={submissionPostage} onChange={setSubmissionPostage} />
            <MoneyField label="Return postage (whole batch)" value={returnPostage} onChange={setReturnPostage} />
            <MoneyField label="Insurance (whole batch)" value={batchInsurance} onChange={setBatchInsurance} />
            <MoneyField label="Consumables (per card)" hint="Sleeve, card saver, tape." value={consumables} onChange={setConsumables} />
            <MoneyField label="Declared-value upcharge" value={upcharge} onChange={setUpcharge} />
          </div>
          {scale && upcharge.amount !== null && (
            <div className="deal-upcharge-grades">
              <span className="deal-field-label">Which outcomes trigger the upcharge?</span>
              <p className="panel-caption">
                Leave all unticked to charge it to every outcome. Ticking specific grades charges it only to those — which is
                the honest treatment when the upcharge depends on the slab&apos;s value.
              </p>
              {pricedRungs.map((r) => (
                <label key={r.key} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={upchargeGrades.includes(r.key)}
                    onChange={(e) =>
                      setUpchargeGrades((prev) => (e.target.checked ? [...prev, r.key] : prev.filter((k) => k !== r.key)))
                    }
                  />
                  {r.label}
                </label>
              ))}
            </div>
          )}
        </>
      )}

      <h3>Resale</h3>
      {bundle.gradedPriceReferenceError && (
        <p className="notice-amber">{bundle.gradedPriceReferenceError}</p>
      )}
      {bundle.gradedPriceReference && (
        <p className="panel-caption">
          Market reference available for{" "}
          {bundle.gradedPriceReference.gradersAvailable.join(", ")}
          {bundle.gradedPriceReference.capturedAt &&
            ` · captured ${new Date(bundle.gradedPriceReference.capturedAt).toLocaleDateString("en-GB")}`}
          . These are the provider&apos;s figures, US-market and converted once into GBP — a starting point, not UK sold
          evidence. Taking one marks it as a provider reference, never as your own comp.
          {bundle.gradedPriceReference.unmappedTierKeys.length > 0 && (
            <>
              {" "}
              Not shown, because no verified grade scale can place them:{" "}
              {bundle.gradedPriceReference.unmappedTierKeys.join(", ")}.
            </>
          )}
        </p>
      )}
      <div className="deal-grid">
        {strategy === "GRADE" && scale ? (
          pricedRungs.map((r) => (
            <div key={r.key} className="deal-resale-row">
              <MoneyField
                label={`Value at ${r.label}`}
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
            label="Raw resale value"
            value={resale.RAW ?? blank()}
            onChange={(next) => setResale((prev) => ({ ...prev, RAW: next }))}
          />
        )}
        <MoneyField label="Postage the buyer pays" value={buyerPaidShipping} onChange={setBuyerPaidShipping} />
        <MoneyField label="Outbound postage (your cost)" value={outboundPostage} onChange={setOutboundPostage} />
        <MoneyField label="Packaging" value={packaging} onChange={setPackaging} />
        <MoneyField label="Sale insurance" value={saleInsurance} onChange={setSaleInsurance} />
        <label className="deal-field">
          <span className="deal-field-label">Where the valuations came from</span>
          <input type="text" placeholder="e.g. Terapeak UK sold, 8 comps" value={valuationSource} onChange={(e) => setValuationSource(e.target.value)} />
        </label>
        <label className="deal-field">
          <span className="deal-field-label">Valuation date</span>
          <input type="date" value={valuationDate} onChange={(e) => setValuationDate(e.target.value)} />
        </label>
      </div>
      <label className="checkbox-label" title="A US comp converted into pounds is still a US-market reference, not observed UK resale evidence.">
        <input type="checkbox" checked={foreignReference} onChange={(e) => setForeignReference(e.target.checked)} />
        These valuations are a foreign-market reference, not UK sold evidence
      </label>

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
          <h3>Offer</h3>
          {bundle.purchasedInventoryId ? (
            <p className="result-count">Already purchased — this deal is recorded in inventory and its assumptions are frozen.</p>
          ) : (
            <>
              <div className="deal-grid">
                <label className="deal-field">
                  <span className="deal-field-label">Offer amount</span>
                  <span className="deal-field-row">
                    <input type="number" step="0.01" min="0" value={offerAmount} onChange={(e) => setOfferAmount(e.target.value)} />
                    <select value={offerCurrency} onChange={(e) => setOfferCurrency(e.target.value)}>
                      {CURRENCIES.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
                <div className="deal-actions">
                  <button onClick={handlePlaceOffer}>{pendingOffer ? "Revise offer" : "Record pending offer"}</button>
                  {pendingOffer && (
                    <>
                      <button onClick={() => handleResolve(pendingOffer.id, "ACCEPTED")}>Accepted</button>
                      <button onClick={() => handleResolve(pendingOffer.id, "REJECTED")}>Rejected</button>
                      <button onClick={() => handleResolve(pendingOffer.id, "EXPIRED")}>Expired</button>
                      <button onClick={() => handleResolve(pendingOffer.id, "WITHDRAWN")}>Withdrawn</button>
                    </>
                  )}
                </div>
              </div>
              <p className="panel-caption">
                A pending offer is not money spent. It is counted as potential acquisition spend, separately from what you
                have actually paid.
              </p>
              {bundle.offers.length > 0 && (
                <table className="deal-cost-table">
                  <tbody>
                    {bundle.offers.map((o) => (
                      <tr key={o.id}>
                        <td>{new Date(o.placed_at).toLocaleString("en-GB")}</td>
                        <td>
                          {o.amount} {o.currency}
                          {o.currency !== "GBP" && <span className="deal-fx"> = {money(o.amount_gbp)}</span>}
                        </td>
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
                        cost, enter 0 and mark it confirmed.
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
