import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "StockSense — Inventory Forecasting",
  description:
    "Supply chain/inventory forecasting: Holt-Winters from scratch vs baselines, rolling-origin backtesting (MAPE/WAPE), reorder points with safety stock.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
