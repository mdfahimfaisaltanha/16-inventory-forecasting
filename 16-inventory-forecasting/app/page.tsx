"use client"

import { useCallback, useEffect, useState } from "react"

type ReorderInfo = {
  leadTimeDemand: number
  safetyStock: number
  reorderPoint: number
  belowReorderPoint: boolean
  projectedStockoutDay: string | null
  suggestedOrderQty: number
  zUsed: number
}

type ProductRow = {
  sku: string
  name: string
  category: string
  unit_cost_cents: number
  lead_time_days: number
  on_hand: number
  service_level: number
  champion_method: string | null
  reorder: ReorderInfo | null
  status: "ok" | "reorder_now" | "stockout_risk" | "unforecasted"
}

type Detail = {
  product: {
    sku: string
    name: string
    category: string
    lead_time_days: number
    on_hand: number
    service_level: number
    champion_method: string | null
    residual_std: number | null
  }
  history: Array<{ day: string; qty: number }>
  forecast: Array<{ day: string; p50: number; lo: number; hi: number }>
  backtests: Array<{ method: string; mape_fold4: number | null; wape_fold4: number; wape_avg: number }>
  reorder: ReorderInfo | null
}

type MetricRow = {
  sku: string
  name: string
  champion_method: string | null
  method: string
  mape_fold4: number | null
  wape_fold4: number
  wape_avg: number
}

type User = { id: number; name: string; email: string; role: string }

const METHOD_LABELS: Record<string, string> = {
  seasonal_naive: "Seasonal naive (t-7)",
  moving_avg_28: "28-day moving average",
  holt_winters: "Holt-Winters",
}

function pct(x: number | null | undefined): string {
  if (x === null || x === undefined) return "—"
  return `${(Number(x) * 100).toFixed(1)}%`
}

function StatusBadge({ status }: { status: ProductRow["status"] }) {
  if (status === "ok") return <span className="badge good">ok</span>
  if (status === "reorder_now") return <span className="badge warn">reorder now</span>
  if (status === "stockout_risk") return <span className="badge bad">stockout risk</span>
  return <span className="badge">unforecasted</span>
}

export default function Home() {
  const [tab, setTab] = useState<"forecast" | "backtests" | "reorder">("forecast")
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((d) => setUser(d.user))
      .catch(() => {})
  }, [])

  return (
    <main>
      <h1>📦 StockSense</h1>
      <p className="subtitle">
        Inventory forecasting for Bluecrate Distribution — Holt-Winters from scratch vs baselines,
        rolling-origin backtests, and reorder points with safety stock.
      </p>

      <div className="tabs">
        <button className={tab === "forecast" ? "active" : ""} onClick={() => setTab("forecast")}>
          📈 Forecast explorer
        </button>
        <button className={tab === "backtests" ? "active" : ""} onClick={() => setTab("backtests")}>
          🧪 Backtests
        </button>
        <button className={tab === "reorder" ? "active" : ""} onClick={() => setTab("reorder")}>
          📦 Reorder desk
        </button>
      </div>

      {tab === "forecast" && <ForecastTab />}
      {tab === "backtests" && <BacktestsTab />}
      {tab === "reorder" && <ReorderTab user={user} setUser={setUser} />}
    </main>
  )
}

/* ------------------------------------------------------------------ */
/* Forecast explorer                                                   */
/* ------------------------------------------------------------------ */

function ForecastChart({ detail }: { detail: Detail }) {
  const hist = detail.history.slice(-120)
  const fc = detail.forecast
  const W = 960
  const H = 300
  const PADL = 42
  const PADB = 24
  const PADT = 10
  const n = hist.length + fc.length
  if (n === 0) return null

  const maxY = Math.max(...hist.map((h) => h.qty), ...fc.map((f) => f.hi), 1)
  const x = (i: number) => PADL + (i / Math.max(n - 1, 1)) * (W - PADL - 10)
  const y = (v: number) => PADT + (1 - v / maxY) * (H - PADT - PADB)

  const histPts = hist.map((h, i) => `${x(i)},${y(h.qty)}`).join(" ")
  const fcPts = fc.map((f, i) => `${x(hist.length + i)},${y(f.p50)}`).join(" ")
  const bandTop = fc.map((f, i) => `${x(hist.length + i)},${y(f.hi)}`)
  const bandBot = [...fc].reverse().map((f, i) => `${x(hist.length + fc.length - 1 - i)},${y(f.lo)}`)
  const band = [...bandTop, ...bandBot].join(" ")
  const splitX = x(hist.length - 1)

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="History and forecast chart">
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={PADL} y1={y(maxY * f)} x2={W - 10} y2={y(maxY * f)} stroke="#2a3040" strokeDasharray="3 5" />
          <text x={PADL - 6} y={y(maxY * f) + 4} fill="#99a1b3" fontSize="10" textAnchor="end">
            {Math.round(maxY * f)}
          </text>
        </g>
      ))}
      <line x1={splitX} y1={PADT} x2={splitX} y2={H - PADB} stroke="#99a1b3" strokeDasharray="4 4" />
      <text x={splitX + 5} y={PADT + 10} fill="#99a1b3" fontSize="10">
        today → 28-day forecast
      </text>
      {fc.length > 1 && <polygon points={band} fill="rgba(217, 126, 74, 0.15)" stroke="none" />}
      {hist.length > 1 && <polyline points={histPts} fill="none" stroke="#e9ecf2" strokeWidth="1.6" />}
      {fc.length > 1 && (
        <polyline points={fcPts} fill="none" stroke="#d97e4a" strokeWidth="2" strokeDasharray="6 4" />
      )}
    </svg>
  )
}

function ForecastTab() {
  const [products, setProducts] = useState<ProductRow[]>([])
  const [sku, setSku] = useState<string>("")
  const [detail, setDetail] = useState<Detail | null>(null)

  useEffect(() => {
    fetch("/api/products")
      .then((r) => r.json())
      .then((d) => {
        const list: ProductRow[] = d.products ?? []
        setProducts(list)
        if (list.length > 0) setSku((s) => s || list[0].sku)
      })
  }, [])

  useEffect(() => {
    if (!sku) return
    fetch(`/api/products?sku=${encodeURIComponent(sku)}`)
      .then((r) => r.json())
      .then((d) => setDetail(d.product ? d : null))
  }, [sku])

  return (
    <div className="card">
      <h2>Forecast explorer</h2>
      <div className="form-grid">
        <div>
          <label>SKU</label>
          <select value={sku} onChange={(e) => setSku(e.target.value)}>
            {products.map((p) => (
              <option key={p.sku} value={p.sku}>
                {p.sku} — {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {detail && (
        <>
          <h3>
            {detail.product.name}{" "}
            {detail.product.champion_method && (
              <span className="badge accent">champion: {METHOD_LABELS[detail.product.champion_method]}</span>
            )}
            {detail.backtests[0] && (
              <span className="badge">holdout WAPE {pct(detail.backtests[0].wape_fold4)}</span>
            )}
          </h3>
          <p className="muted">
            Solid line: last 120 days of actual demand. Dashed: 28-day forecast from the champion method, with an
            80% band from recent one-step forecast errors.
          </p>
          <ForecastChart detail={detail} />
          {detail.reorder && (
            <div className="stat-grid" style={{ marginTop: 12 }}>
              <div className="stat">
                <div className="v">{detail.product.on_hand}</div>
                <div className="k">on hand</div>
              </div>
              <div className="stat accent">
                <div className="v">{detail.reorder.reorderPoint}</div>
                <div className="k">reorder point (lead-time demand {detail.reorder.leadTimeDemand} + safety {detail.reorder.safetyStock})</div>
              </div>
              <div className="stat">
                <div className="v">{detail.product.lead_time_days}d</div>
                <div className="k">supplier lead time</div>
              </div>
              <div className={`stat ${detail.reorder.projectedStockoutDay ? "warn" : "good"}`}>
                <div className="v">{detail.reorder.projectedStockoutDay ?? "28d+"}</div>
                <div className="k">projected stockout (within forecast horizon)</div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Backtests                                                           */
/* ------------------------------------------------------------------ */

function BacktestsTab() {
  const [rows, setRows] = useState<MetricRow[]>([])
  const [scored, setScored] = useState(true)

  useEffect(() => {
    fetch("/api/metrics")
      .then((r) => r.json())
      .then((d) => {
        setRows(d.results ?? [])
        setScored(d.scored)
      })
  }, [])

  if (!scored)
    return (
      <div className="card">
        <p className="muted">
          No backtests yet — run <code>npm run forecast</code>, then refresh.
        </p>
      </div>
    )

  const bySku = new Map<string, MetricRow[]>()
  for (const r of rows) {
    const list = bySku.get(r.sku) ?? []
    list.push(r)
    bySku.set(r.sku, list)
  }

  return (
    <div className="card">
      <h2>Rolling-origin backtests</h2>
      <p className="muted">
        Protocol: 4 folds of 14 days over the last 8 weeks. Holt-Winters smoothing parameters are grid-searched on
        folds 1-3 only; every number below is from <strong>fold 4, a clean holdout</strong> no method saw during
        tuning. Champion rows (lowest holdout WAPE) are highlighted — note the SKUs where a baseline beats
        Holt-Winters. That is the honest reason backtesting exists.
      </p>
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Method</th>
            <th>Holdout MAPE</th>
            <th>Holdout WAPE</th>
            <th>4-fold avg WAPE</th>
          </tr>
        </thead>
        <tbody>
          {[...bySku.entries()].map(([sku, list]) =>
            list.map((r, i) => (
              <tr key={`${sku}-${r.method}`} className={r.method === r.champion_method ? "champion" : ""}>
                <td className="mono">{i === 0 ? `${r.sku} — ${r.name}` : ""}</td>
                <td>
                  {METHOD_LABELS[r.method]}{" "}
                  {r.method === r.champion_method && <span className="badge accent">champion</span>}
                </td>
                <td>{pct(r.mape_fold4)}</td>
                <td>{pct(r.wape_fold4)}</td>
                <td className="muted">{pct(r.wape_avg)}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      <p className="muted">
        MAPE shows “—” where undefined (days with zero actual demand are skipped; for the intermittent SKU most
        days are zero). WAPE (Σ|error| / Σactual) stays defined — that is why both are reported.
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Reorder desk                                                        */
/* ------------------------------------------------------------------ */

function ReorderTab({ user, setUser }: { user: User | null; setUser: (u: User | null) => void }) {
  const [products, setProducts] = useState<ProductRow[]>([])
  const [selected, setSelected] = useState<ProductRow | null>(null)

  const load = useCallback(() => {
    fetch("/api/products")
      .then((r) => r.json())
      .then((d) => setProducts(d.products ?? []))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const attention = products.filter((p) => p.status === "stockout_risk" || p.status === "reorder_now").length

  return (
    <>
      <div className="card">
        <h2>
          Reorder desk{" "}
          <span className={`badge ${attention > 0 ? "warn" : "good"}`}>{attention} SKUs need attention</span>
        </h2>
        <p className="muted">
          Reorder point = forecast demand over supplier lead time + safety stock (z × σ√L at the SKU&apos;s
          service level). Click a row to open the what-if panel.
        </p>
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>On hand</th>
              <th>Reorder point</th>
              <th>Lead time</th>
              <th>Projected stockout</th>
              <th>Suggested order</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.sku} className="clickable" onClick={() => setSelected(p)}>
                <td>
                  <span className="mono">{p.sku}</span> {p.name}
                </td>
                <td>{p.on_hand}</td>
                <td>{p.reorder?.reorderPoint ?? "—"}</td>
                <td>{p.lead_time_days}d</td>
                <td>{p.reorder?.projectedStockoutDay ?? "28d+"}</td>
                <td>{p.reorder ? `${p.reorder.suggestedOrderQty} units` : "—"}</td>
                <td>
                  <StatusBadge status={p.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && <WhatIfPanel product={selected} user={user} setUser={setUser} onClose={() => setSelected(null)} />}
    </>
  )
}

function WhatIfPanel({
  product,
  user,
  setUser,
  onClose,
}: {
  product: ProductRow
  user: User | null
  setUser: (u: User | null) => void
  onClose: () => void
}) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loginError, setLoginError] = useState("")
  const [serviceLevel, setServiceLevel] = useState(String(product.service_level))
  const [leadTime, setLeadTime] = useState(String(product.lead_time_days))
  const [onHand, setOnHand] = useState(String(product.on_hand))
  const [result, setResult] = useState<{ reorder: ReorderInfo; orderCostCents: number } | null>(null)
  const [error, setError] = useState("")

  const login = async () => {
    setLoginError("")
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()
    if (!res.ok) {
      setLoginError(data.error ?? "Login failed")
      return
    }
    setUser(data.user)
  }

  const run = async () => {
    setError("")
    setResult(null)
    const res = await fetch("/api/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sku: product.sku,
        serviceLevel: Number(serviceLevel),
        leadTimeDays: Number(leadTime),
        onHand: Number(onHand),
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      setError(data.error ?? "What-if failed")
      return
    }
    setResult(data)
  }

  if (!user) {
    return (
      <div className="card login-wrap">
        <h2>Sign in for what-if planning</h2>
        <p className="muted">
          Seeded planners: <code>planner@bluecrate.test</code> / <code>ops@bluecrate.test</code> with your{" "}
          <code>SEED_PASSWORD</code> (default <code>ChangeMe123!</code>).
        </p>
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="planner@bluecrate.test" />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {loginError && <p className="err-text">{loginError}</p>}
        <p>
          <button className="primary" onClick={login}>
            Sign in
          </button>{" "}
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </p>
      </div>
    )
  }

  return (
    <div className="card">
      <h2>
        What-if: <span className="mono">{product.sku}</span> {product.name}{" "}
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </h2>
      <p className="muted">
        Pure math over the stored forecast — no model rerun. Push the service level from 95% to 99% and watch
        safety stock (and the order cost) climb; that is the inventory-vs-availability trade-off in one slider.
      </p>
      <div className="form-grid">
        <div>
          <label>Service level</label>
          <select value={serviceLevel} onChange={(e) => setServiceLevel(e.target.value)}>
            <option value="0.90">90%</option>
            <option value="0.95">95%</option>
            <option value="0.975">97.5%</option>
            <option value="0.99">99%</option>
          </select>
        </div>
        <div>
          <label>Lead time (days)</label>
          <input value={leadTime} onChange={(e) => setLeadTime(e.target.value)} />
        </div>
        <div>
          <label>On hand (units)</label>
          <input value={onHand} onChange={(e) => setOnHand(e.target.value)} />
        </div>
        <div>
          <label>&nbsp;</label>
          <button className="primary" onClick={run}>
            Recompute
          </button>
        </div>
      </div>
      {error && <div className="error-box">{error}</div>}
      {result && (
        <div className="stat-grid" style={{ marginTop: 12 }}>
          <div className="stat accent">
            <div className="v">{result.reorder.reorderPoint}</div>
            <div className="k">reorder point (z = {result.reorder.zUsed})</div>
          </div>
          <div className="stat">
            <div className="v">{result.reorder.safetyStock}</div>
            <div className="k">safety stock</div>
          </div>
          <div className="stat">
            <div className="v">{result.reorder.suggestedOrderQty}</div>
            <div className="k">suggested order (units)</div>
          </div>
          <div className="stat warn">
            <div className="v">${(result.orderCostCents / 100).toFixed(2)}</div>
            <div className="k">order cost at unit cost</div>
          </div>
        </div>
      )}
    </div>
  )
}
