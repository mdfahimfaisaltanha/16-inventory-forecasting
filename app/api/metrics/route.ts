// GET /api/metrics — the full backtest table: every SKU × method with
// fold-4 (clean holdout) MAPE/WAPE and the 4-fold average, champion marked.

import { NextResponse } from "next/server"
import { query } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET() {
  const { rows } = await query(
    `SELECT p.sku, p.name, p.champion_method, b.method,
            b.mape_fold4, b.wape_fold4, b.wape_avg
     FROM backtests b JOIN products p ON p.id = b.product_id
     ORDER BY p.sku, b.wape_fold4`,
  )
  if (rows.length === 0) {
    return NextResponse.json({ results: [], scored: false })
  }
  return NextResponse.json({ results: rows, scored: true })
}
