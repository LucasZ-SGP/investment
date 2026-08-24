export const pct = (v: number, d = 2) => `${(v * 100).toFixed(d)}%`;
export const signed = (v: number, d = 2) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
export const cls = (v: number) => (v >= 0 ? "pos" : "neg");
export const usd = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const mult = (v: number) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(1)}M×` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k×` : `${v.toFixed(1)}×`;
/** Months -> "6年8个月". Drawdown lengths are far more legible this way. */
export const months = (m: number) => {
  const y = Math.floor(m / 12);
  const r = m % 12;
  return y ? `${y}年${r ? `${r}个月` : ""}` : `${r}个月`;
};
