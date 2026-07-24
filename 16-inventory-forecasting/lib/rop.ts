// Reorder-point math — the operational payoff of the forecasts.
//
// Classic formulation:
//   ROP          = demand over lead time + safety stock
//   safety stock = z(serviceLevel) * sigma_daily * sqrt(leadTimeDays)
//
// where sigma_daily is the std of recent one-step-ahead FORECAST ERRORS (not
// of demand itself — if the model explains the weekly cycle, that variance
// shouldn't be bought as inventory). The sqrt(L) scaling assumes independent
// daily errors; positively autocorrelated errors would make this optimistic
// (see README honesty notes).

import type { ForecastPoint, ReorderInfo } from "./types"

// Standard normal quantiles for the service levels the UI offers.
export const Z_TABLE: Record<string, number> = {
  "0.90": 1.282,
  "0.95": 1.645,
  "0.975": 1.96,
  "0.99": 2.326,
}

export function zFor(serviceLevel: number): number {
  const key = serviceLevel.toFixed(serviceLevel === 0.975 ? 3 : 2)
  return Z_TABLE[key] ?? Z_TABLE["0.95"]
}

export function computeReorder(args: {
  forecast: ForecastPoint[] // next 28 days, ordered
  onHand: number
  leadTimeDays: number
  serviceLevel: number
  residualStd: number
}): ReorderInfo {
  const { forecast, onHand, leadTimeDays, serviceLevel, residualStd } = args
  const z = zFor(serviceLevel)

  const leadDays = forecast.slice(0, Math.min(leadTimeDays, forecast.length))
  const leadTimeDemand = Math.round(leadDays.reduce((s, f) => s + f.p50, 0))
  const safetyStock = Math.ceil(z * residualStd * Math.sqrt(leadTimeDays))
  const reorderPoint = leadTimeDemand + safetyStock

  // First day the cumulative forecast eats through on-hand stock.
  let cum = 0
  let projectedStockoutDay: string | null = null
  for (const f of forecast) {
    cum += f.p50
    if (cum > onHand) {
      projectedStockoutDay = f.day
      break
    }
  }

  const demand28 = Math.round(forecast.reduce((s, f) => s + f.p50, 0))
  const suggestedOrderQty = Math.max(0, demand28 + safetyStock - onHand)

  return {
    leadTimeDemand,
    safetyStock,
    reorderPoint,
    belowReorderPoint: onHand <= reorderPoint,
    projectedStockoutDay,
    suggestedOrderQty,
    zUsed: z,
  }
}
