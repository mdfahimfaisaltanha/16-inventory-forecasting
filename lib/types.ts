// Shared domain types for StockSense.

export type User = {
  id: number
  name: string
  email: string
  role: "planner" | "admin"
}

export const METHODS = ["seasonal_naive", "moving_avg_28", "holt_winters"] as const
export type Method = (typeof METHODS)[number]

export type Product = {
  id: number
  sku: string
  name: string
  category: string
  unit_cost_cents: number
  lead_time_days: number
  on_hand: number
  service_level: number // e.g. 0.95
  // written by scripts/forecast.mjs
  champion_method: Method | null
  residual_std: number | null // std of recent one-step-ahead errors, for bands + safety stock
}

export type SalesPoint = {
  day: string // YYYY-MM-DD
  qty: number
}

export type ForecastPoint = {
  day: string
  p50: number
  lo: number // 80% band
  hi: number
}

export type BacktestRow = {
  sku: string
  method: Method
  mape_fold4: number | null // clean holdout; null when undefined (all-zero actuals)
  wape_fold4: number
  wape_avg: number // average across all 4 folds, for reference
}

// Computed replenishment view (lib/rop.ts + /api/products)
export type ReorderInfo = {
  leadTimeDemand: number // sum of p50 over lead time
  safetyStock: number
  reorderPoint: number
  belowReorderPoint: boolean
  projectedStockoutDay: string | null // first day cumulative forecast exceeds on-hand
  suggestedOrderQty: number // cover 28d + safety - on hand
  zUsed: number
}
