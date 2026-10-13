// GET /api/products            — replenishment overview: every SKU with its
//                                computed reorder info and stock status
// GET /api/products?sku=BC-1005 — detail: 120d history + 28d forecast + backtests

import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { computeReorder } from "@/lib/rop"
import type { ForecastPoint, Product } from "@/lib/types"

export const dynamic = "force-dynamic"

async function forecastFor(productId: number): Promise<ForecastPoint[]> {
  const { rows } = await query<{ day: string; p50: number; lo: number; hi: number }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, p50, lo, hi
     FROM forecasts WHERE product_id = $1 ORDER BY day`,
    [productId],
  )
  return rows.map((r) => ({ day: r.day, p50: Number(r.p50), lo: Number(r.lo), hi: Number(r.hi) }))
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const sku = searchParams.get("sku")

  if (sku) {
    const { rows } = await query<Product & Record<string, unknown>>(`SELECT * FROM products WHERE sku = $1`, [sku])
    if (rows.length === 0) return NextResponse.json({ error: `SKU ${sku} not found` }, { status: 404 })
    const p = rows[0]

    const history = await query<{ day: string; qty: number }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, qty FROM daily_sales
       WHERE product_id = $1 ORDER BY day DESC LIMIT 120`,
      [p.id],
    )
    const forecast = await forecastFor(p.id)
    const backtests = await query(
      `SELECT method, mape_fold4, wape_fold4, wape_avg FROM backtests WHERE product_id = $1 ORDER BY wape_fold4`,
      [p.id],
    )

    const reorder =
      forecast.length > 0 && p.residual_std !== null
        ? computeReorder({
            forecast,
            onHand: p.on_hand,
            leadTimeDays: p.lead_time_days,
            serviceLevel: Number(p.service_level),
            residualStd: Number(p.residual_std),
          })
        : null

    return NextResponse.json({
      product: p,
      history: history.rows.reverse(), // chronological
      forecast,
      backtests: backtests.rows,
      reorder,
    })
  }

  const { rows: products } = await query<Product & Record<string, unknown>>(`SELECT * FROM products ORDER BY sku`)
  const out = []
  for (const p of products) {
    const forecast = await forecastFor(p.id)
    const reorder =
      forecast.length > 0 && p.residual_std !== null
        ? computeReorder({
            forecast,
            onHand: p.on_hand,
            leadTimeDays: p.lead_time_days,
            serviceLevel: Number(p.service_level),
            residualStd: Number(p.residual_std),
          })
        : null
    out.push({
      sku: p.sku,
      name: p.name,
      category: p.category,
      unit_cost_cents: p.unit_cost_cents,
      lead_time_days: p.lead_time_days,
      on_hand: p.on_hand,
      service_level: Number(p.service_level),
      champion_method: p.champion_method,
      reorder,
      status: !reorder
        ? "unforecasted"
        : reorder.projectedStockoutDay !== null &&
            new Date(reorder.projectedStockoutDay).getTime() - Date.now() < p.lead_time_days * 86400_000
          ? "stockout_risk" // projected to run dry before a reorder placed today could arrive
          : reorder.belowReorderPoint
            ? "reorder_now"
            : "ok",
    })
  }
  return NextResponse.json({ products: out })
}
