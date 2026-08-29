import { Db } from "@mwmc/db";
import type { CardPrinting } from "@mwmc/core";

export async function upsertCard(db: Db, printing: CardPrinting): Promise<void> {
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
}
