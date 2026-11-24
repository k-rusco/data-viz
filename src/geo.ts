export const ORIGIN = { lon: 8.23, lat: 46.8 }
export const METERS_PER_UNIT = 10000
const RELIEF = 7.4

const COS = Math.cos((ORIGIN.lat * Math.PI) / 180)

export function toWorld(lon: number, lat: number): [number, number] {
  const x = ((lon - ORIGIN.lon) * 111320 * COS) / METERS_PER_UNIT
  const z = (-(lat - ORIGIN.lat) * 110540) / METERS_PER_UNIT
  return [x, z]
}

export function fromWorld(x: number, z: number): [number, number] {
  const lon = ORIGIN.lon + (x * METERS_PER_UNIT) / (111320 * COS)
  const lat = ORIGIN.lat - (z * METERS_PER_UNIT) / 110540
  return [lon, lat]
}

type Peak = { lat: number; lon: number; h: number; s: number }

const PEAKS: Peak[] = [
  { lat: 45.937, lon: 7.867, h: 3600, s: 0.2 },
  { lat: 45.976, lon: 7.659, h: 2800, s: 0.13 },
  { lat: 46.094, lon: 7.857, h: 2700, s: 0.15 },
  { lat: 46.101, lon: 7.716, h: 2100, s: 0.11 },
  { lat: 45.97, lon: 7.45, h: 2300, s: 0.16 },
  { lat: 45.937, lon: 7.299, h: 2400, s: 0.15 },
  { lat: 46.05, lon: 7.05, h: 1800, s: 0.16 },
  { lat: 46.537, lon: 7.962, h: 2900, s: 0.18 },
  { lat: 46.537, lon: 8.126, h: 2700, s: 0.17 },
  { lat: 46.47, lon: 7.78, h: 1600, s: 0.14 },
  { lat: 46.643, lon: 8.421, h: 2100, s: 0.15 },
  { lat: 46.58, lon: 8.55, h: 1600, s: 0.12 },
  { lat: 46.497, lon: 9.04, h: 1800, s: 0.14 },
  { lat: 46.811, lon: 8.915, h: 2000, s: 0.15 },
  { lat: 46.86, lon: 9.25, h: 1400, s: 0.14 },
  { lat: 46.382, lon: 9.908, h: 2800, s: 0.15 },
  { lat: 46.5, lon: 9.75, h: 1500, s: 0.12 },
  { lat: 46.844, lon: 10.119, h: 1700, s: 0.13 },
  { lat: 46.411, lon: 8.47, h: 1600, s: 0.12 },
  { lat: 46.3, lon: 8.9, h: 1400, s: 0.16 },
  { lat: 47.22, lon: 7.05, h: 620, s: 0.42 },
  { lat: 47.3, lon: 7.85, h: 380, s: 0.36 },
]

export function alpsMeters(lat: number, lon: number): number {
  let h = 360
  for (const p of PEAKS) {
    const dlat = lat - p.lat
    const dlon = (lon - p.lon) * COS
    const d2 = dlat * dlat + dlon * dlon
    h += p.h * Math.exp(-d2 / (2 * p.s * p.s))
  }
  h += 28 * Math.sin(lat * 7.5 + lon * 4.8) * Math.cos(lon * 3.6 - lat * 2.2)
  return Math.max(280, h)
}

export function worldHeight(lat: number, lon: number): number {
  return (alpsMeters(lat, lon) / METERS_PER_UNIT) * RELIEF
}

export function downhill(lat: number, lon: number): [number, number] {
  const step = 0.035
  const hE = alpsMeters(lat, lon + step)
  const hW = alpsMeters(lat, lon - step)
  const hN = alpsMeters(lat + step, lon)
  const hS = alpsMeters(lat - step, lon)
  const [x] = toWorld(lon, lat)
  const [xE] = toWorld(lon + step, lat)
  const [, zN] = toWorld(lon, lat + step)
  const [, zS] = toWorld(lon, lat - step)
  const dhdx = (hE - hW) / (2 * (xE - x) || 1e-6)
  const dhdz = (hS - hN) / (zS - zN || 1e-6)
  let dx = -dhdx
  let dz = -dhdz
  const len = Math.hypot(dx, dz)
  if (len < 1e-4) return [0, 1]
  return [dx / len, dz / len]
}

export function yawFromDownhill(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz)
}
