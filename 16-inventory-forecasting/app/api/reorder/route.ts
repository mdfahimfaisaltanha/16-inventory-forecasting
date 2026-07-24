// POST /api/reorder — the what-if desk (sign-in required).
//
// Recompute reorder point / safety stock / suggested order for a SKU under a
// hypothetical service level, lead time, or on-hand quantity — pure math over
// the stored forecast, no model rerun.
// Body: { sku, serviceLevel?, leadTimeDays?, onHand? }

import { NextRequest, NextResponse } from "next/server"
import { currentUser } from "@/lib/auth"
import { query } from "@/lib/db"
import { computeReorder, Z_TABLE } from "@/lib/rop"
import type { Product } from "@/lib/types"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: "Sign in to use the what-if desk" }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const sku = String(body.sku ?? "").trim().toUpperCase()
  if (!sku) return NextResponse.json({ error: "sku is required" }, { status: 422 })

  const { rows } = await query<Product & Record<string, unknown>>(`SELECT * FROM products WHERE sku = $1`, [sku])
  if (rows.length === 0) return NextResponse.json({ error: `SKU ${sku} not found` }, { status: 404 })
  const p = rows[0]
  if (p.residual_std === null) {
    return NextResponse.json({ error: "SKU has no forecast yet — run: npm run forecast" }, { status: 409 })
  }

  const serviceLevel = body.serviceLevel === undefined ? Number(p.service_level) : Number(body.serviceLevel)
  if (!Object.keys(Z_TABLE).includes(serviceLevel.toFixed(serviceLevel === 0.975 ? 3 : 2))) {
    return NextResponse.json(
      { error: `serviceLevel must be one of: ${Object.keys(Z_TABLE).join(", ")}` },
      { status: 422 },
    )
  }
  const leadTimeDays = body.leadTimeDays === undefined ? p.lead_time_days : Number(body.leadTimeDays)
  if (!Number.isInteger(leadTimeDays) || leadTimeDays < 1 || leadTimeDays > 28) {
    return NextResponse.json({ error: "leadTimeDays must be an integer 1-28" }, { status: 422 })
  }
  const onHand = body.onHand === undefined ? p.on_hand : Number(body.onHand)
  if (!Number.isInteger(onHand) || onHand < 0 || onHand > 1_000_000) {
    return NextResponse.json({ error: "onHand must be an integer 0-1000000" }, { status: 422 })
  }

  const { rows: fRows } = await query<{ day: string; p50: number; lo: number; hi: number }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, p50, lo, hi FROM forecasts WHERE product_id = $1 ORDER BY day`,
    [p.id],
  )
  const forecast = fRows.map((r) => ({ day: r.day, p50: Number(r.p50), lo: Number(r.lo), hi: Number(r.hi) }))

  const reorder = computeReorder({
    forecast,
    onHand,
    leadTimeDays,
    serviceLevel,
    residualStd: Number(p.residual_std),
  })

  return NextResponse.json({
    sku,
    inputs: { serviceLevel, leadTimeDays, onHand },
    reorder,
    orderCostCents: reorder.suggestedOrderQty * p.unit_cost_cents,
  })
}
