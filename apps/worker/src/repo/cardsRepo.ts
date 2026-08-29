import { Db, type CardRow } from "@mwmc/db";
import type { CardPrinting } from "@mwmc/core";

/** Returns "inserted" | "updated" so callers (notably the catalogue sync
 *  engine) can report accurate counts without a separate existence check. */
export async function upsertCard(db: Db, printing: CardPrinting): Promise<"inserted" | "updated"> {
  const existing = await db.queryFirst<Pick<CardRow, "id">>(`SELECT id FROM cards WHERE id = ?`, printing.printingHash);

  await db.exec(
    `INSERT INTO cards (
       id, game, name, set_name, set_code, card_number, year, language,
       edition, variant, finish, rarity, stamp_type, printing_hash, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       rarity = excluded.rarity,
       stamp_type = excluded.stamp_type,
       updated_at = datetime('now')`,
    printing.printingHash,
    printing.game,
    printing.name,
    printing.setName,
    printing.setCode,
    printing.cardNumber,
    printing.year,
    printing.language,
    printing.edition,
    printing.variant,
    printing.finish,
    printing.rarity,
    printing.stampType,
    printing.printingHash,
  );

  return existing ? "updated" : "inserted";
}

export async function markCardEbayScanned(db: Db, cardId: string): Promise<void> {
  await db.exec(`UPDATE cards SET last_ebay_scanned_at = datetime('now') WHERE id = ?`, cardId);
}
