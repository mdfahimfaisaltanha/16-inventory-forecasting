# EVAL — StockSense backtest results

Sample run with the default seed (`DATA_SEED=42`). Reproduce with:

```bash
npm run setup && npm run generate && npm run forecast
```

Protocol: rolling-origin backtest, 4 folds × 14 days over the last 8 weeks. Holt-Winters α/β/γ
grid-searched (36 combos) on folds 1–3 only; **every number below is fold-4 WAPE — a clean
holdout nothing tuned on**. Champion = lowest holdout WAPE per SKU.

## Sample results (seed 42)

| SKU | Personality | naive-7 | ma-28 | Holt-Winters | Champion |
| --- | --- | --- | --- | --- | --- |
| BC-1001 | steady | 13.2% | 10.1% | **9.6%** | holt_winters |
| BC-1002 | weekend ×1.8 | 14.8% | 26.3% | **11.7%** | holt_winters |
| BC-1003 | steady, high volume | 12.4% | **9.3%** | 9.5% | moving_avg_28 |
| BC-1004 | weekend ×2.2 | **15.1%** | 34.9% | 15.6% | seasonal_naive |
| BC-1005 | trending up | 16.0% | 18.7% | **11.2%** | holt_winters |
| BC-1006 | trending down | 13.9% | 12.8% | **10.4%** | holt_winters |
| BC-1007 | promo spikes | 31.5% | **27.8%** | 29.9% | moving_avg_28 |
| BC-1008 | steady | 13.6% | 10.4% | **10.0%** | holt_winters |
| BC-1009 | intermittent (75% zero) | 68.2% | **52.7%** | 57.4% | moving_avg_28 |
| BC-1010 | weekend + trend | 17.3% | 24.1% | **13.5%** | holt_winters |
| BC-1011 | steady, low volume | 15.7% | 12.2% | **11.9%** | holt_winters |
| BC-1012 | trend + promos | 24.6% | 25.3% | **19.8%** | holt_winters |

Your exact numbers will match a same-seed run modulo the history's calendar alignment (weekends
fall on different offsets depending on the day you generate); the *pattern* below is stable.

## How to read this table (the interesting part)

- **Holt-Winters wins where it should** — trend SKUs (1005, 1006, 1010, 1012) are exactly what
  the trend term exists for; naive-7 lags a trending series by construction and ma-28 drags a
  month of stale history behind it.
- **The baselines win four SKUs — and that's the headline.** On stable weekly seasonality
  (BC-1004) seasonal-naive is nearly unbeatable: last Saturday *is* an excellent forecast of next
  Saturday. On flat noise (BC-1003) a 28-day mean is optimal-ish and HW's extra parameters just
  add variance. If your fancy model never loses to a baseline, your evaluation is broken.
- **Promo spikes (BC-1007) hurt everyone.** The spikes are exogenous — no amount of smoothing
  history predicts a marketing decision. Real fix: promo calendars as regressors (which is
  exactly what Prophet's holiday/regressor interface is for).
- **The intermittent SKU (BC-1009) is honest failure.** ~75% zero days: MAPE is undefined on most
  days (shown as “—” in the UI), and 50%+ WAPE is *normal* for lumpy demand at this volume. The
  textbook fix is Croston's method — called out in the README as the first thing to add, not
  hand-waved away.

## MAPE vs WAPE (why both are reported)

| Metric | Definition | Fails when |
| --- | --- | --- |
| MAPE | mean of \|error/actual\| over nonzero days | zero-demand days (undefined); tiny actuals (a miss of 2 on actual 1 = 200%) |
| WAPE | Σ\|error\| / Σactual | total demand ≈ 0 in the window |

WAPE is the planning metric — it weights error by volume, which is what inventory dollars care
about. MAPE is reported because everyone asks for it, and knowing where it lies is part of the
deliverable.

## From forecast to reorder point (worked example, BC-1005)

Thermal Flask: lead time 5 days, champion HW forecasting ~36 units/day rising, residual σ ≈ 5.1,
service level 95% (z = 1.645):

```
lead-time demand = Σ next 5 days p50           ≈ 181 units
safety stock     = 1.645 × 5.1 × √5            ≈ 19 units
reorder point    = 181 + 19                     = 200 units
on hand          = 320 → above ROP, but projected stockout in ~9 days:
                   with a 5-day lead time, the desk flags it before it's urgent
```

Push service level to 99% in the what-if panel: z jumps to 2.326, safety stock to ~27, and the
suggested order cost rises accordingly — the availability-vs-inventory trade-off, priced.
