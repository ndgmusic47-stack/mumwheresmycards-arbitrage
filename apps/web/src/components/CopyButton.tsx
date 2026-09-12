import { useEffect, useRef, useState } from "react";

/**
 * COPY ONE EXACT STRING TO THE CLIPBOARD.
 *
 * Asked for because the card identity is the one thing that constantly has to
 * leave this app by hand — into an eBay search box, a PSA submission form, a
 * message to a seller — and retyping "Generations: Radiant Collection
 * #RC29/RC32" is both slow and the easiest place in the whole workflow to
 * introduce a wrong card.
 *
 * IT NEVER CLAIMS A COPY IT DID NOT MAKE. `navigator.clipboard` is unavailable
 * outside a secure context and can be refused by the browser at any time, so
 * there is a `execCommand` fallback and, if BOTH fail, the button says
 * "couldn't copy" and shows the text for manual selection. A button that
 * flashes "Copied!" while the clipboard still holds the previous card is
 * exactly the kind of quiet wrongness that ends with the wrong card bought.
 */
export function CopyButton({ value, label, title }: { value: string; label: string; title?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function flash(next: "copied" | "failed") {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        flash("copied");
        return;
      }
    } catch {
      // Fall through to the legacy path rather than reporting failure yet.
    }
    try {
      const el = document.createElement("textarea");
      el.value = value;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      flash(ok ? "copied" : "failed");
    } catch {
      flash("failed");
    }
  }

  return (
    <button
      type="button"
      className={`copy-chip${state === "failed" ? " copy-chip-failed" : ""}`}
      onClick={copy}
      // The full value is in the tooltip, so a failed copy still leaves the
      // operator somewhere to read it from.
      title={title ?? value}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy — see tooltip" : label}
    </button>
  );
}

/**
 * The card's identity, in the three forms that actually get pasted somewhere.
 *
 * Built from the CARD record, not the listing title — the listing title is
 * whatever the seller typed, and half the point of this app is that the card
 * has been resolved to a catalogue entry. Copying the seller's wording back
 * out would defeat that.
 */
export function CardIdentityCopyStrip({
  name,
  setName,
  cardNumber,
}: {
  name: string | null | undefined;
  setName: string | null | undefined;
  cardNumber: string | null | undefined;
}) {
  if (!name) return null;
  const full = [name, setName, cardNumber ? `#${cardNumber}` : null].filter(Boolean).join(" — ").replace(" — #", " #");
  const search = [name, cardNumber].filter(Boolean).join(" ");

  return (
    <div className="copy-strip">
      <span className="copy-strip-label">Copy</span>
      <CopyButton value={full} label="Card, set & number" />
      {cardNumber && <CopyButton value={cardNumber} label="Number only" />}
      <CopyButton value={search} label="eBay search" title={`Search text: ${search}`} />
    </div>
  );
}
