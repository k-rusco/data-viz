import type { Dataset, Glacier } from "./types"
import { downhill, toWorld, worldHeight, yawFromDownhill } from "./geo"

export type Ice = Glacier & {
  pref: number[]
  totalM: number
  estStartKm: number
  x: number
  z: number
  y: number
  dx: number
  dz: number
  yaw: number
  widthKm: number
}

export function prepare(data: Dataset): Ice[] {
  return data.glaciers.map((g) => {
    const pref: number[] = []
    let sum = 0
    for (const value of g.dl) {
      if (value != null) sum += value
      pref.push(sum)
    }
    const estNow =
      g.area != null
        ? Math.max(0.35, Math.sqrt(g.area) * 2.15)
        : Math.max(0.55, (Math.abs(sum) / 1000) * 0.9 + 0.35)
    const estStartKm = Math.min(28, Math.max(estNow - sum / 1000, 0.28))
    const [x, z] = toWorld(g.lon, g.lat)
    const [dx, dz] = downhill(g.lat, g.lon)
    return {
      ...g,
      pref,
      totalM: sum,
      estStartKm,
      x,
      z,
      y: worldHeight(g.lat, g.lon),
      dx,
      dz,
      yaw: yawFromDownhill(dx, dz),
      widthKm: Math.max(0.22, Math.sqrt(estStartKm) * 0.52),
    }
  })
}

export function cum(g: Ice, year: number): number {
  if (year < g.y0 || g.pref.length === 0) return 0
  const index = Math.min(g.pref.length - 1, year - g.y0)
  return g.pref[Math.max(0, index)]
}

export function annual(g: Ice, year: number): number | null {
  const index = year - g.y0
  if (index < 0 || index >= g.dl.length) return null
  return g.dl[index]
}

export function mass(g: Ice, year: number): number | null {
  if (g.b0 == null || !g.ba) return null
  const index = year - g.b0
  if (index < 0 || index >= g.ba.length) return null
  return g.ba[index]
}

export function lengthKm(g: Ice, year: number): number {
  return Math.max(0.08, g.estStartKm + cum(g, year) / 1000)
}

export function lastYear(g: Ice): number {
  return g.y0 + g.dl.length - 1
}

export function passes(
  g: Ice,
  basin: string,
  massOnly: boolean,
  query: string,
): boolean {
  if (basin !== "all" && g.basin !== basin) return false
  if (massOnly && !g.ba) return false
  if (!query) return true
  return g.name.toLowerCase().includes(query) || g.short.toLowerCase().includes(query)
}

export function formatDelta(meters: number): string {
  const sign = meters > 0.5 ? "+" : meters < -0.5 ? "−" : ""
  const abs = Math.abs(meters)
  if (abs >= 1000) {
    const km = abs / 1000
    return `${sign}${km >= 10 ? km.toFixed(0) : km.toFixed(1)} km`
  }
  return `${sign}${Math.round(abs)} m`
}

export function formatWater(mm: number): string {
  const meters = mm / 1000
  const sign = meters > 0 ? "+" : "−"
  return `${sign}${Math.abs(meters).toFixed(2)} m w.e.`
}

export type YearStats = {
  retreat: number
  advance: number
  still: number
  quiet: number
  observed: number
  massMean: number | null
}

export function yearStats(glaciers: Ice[], year: number, ok: (g: Ice) => boolean): YearStats {
  let retreat = 0
  let advance = 0
  let still = 0
  let quiet = 0
  let massSum = 0
  let massN = 0
  for (const g of glaciers) {
    if (!ok(g)) continue
    const delta = annual(g, year)
    if (delta == null) {
      quiet += 1
      continue
    }
    if (delta < -1) retreat += 1
    else if (delta > 1) advance += 1
    else still += 1
    const balance = mass(g, year)
    if (balance != null) {
      massSum += balance
      massN += 1
    }
  }
  return {
    retreat,
    advance,
    still,
    quiet,
    observed: retreat + advance + still,
    massMean: massN ? massSum / massN : null,
  }
}

export function topLosses(glaciers: Ice[], year: number, ok: (g: Ice) => boolean, count = 5) {
  return glaciers
    .filter((g) => ok(g) && g.y0 <= year)
    .map((g) => ({ g, loss: cum(g, year) }))
    .sort((a, b) => a.loss - b.loss)
    .slice(0, count)
}
