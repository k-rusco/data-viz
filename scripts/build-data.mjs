import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const raw = (name) => readFileSync(join(root, "data/raw", name), "utf8")

function parseCSV(text) {
  const rows = []
  let row = []
  let cur = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += c
    } else if (c === '"') quoted = true
    else if (c === ",") {
      row.push(cur)
      cur = ""
    } else if (c === "\n") {
      row.push(cur)
      rows.push(row)
      row = []
      cur = ""
    } else if (c !== "\r") cur += c
  }
  if (cur.length || row.length) {
    row.push(cur)
    rows.push(row)
  }
  return rows
}

function lv95ToWgs(easting, northing) {
  const y = (easting - 2_600_000) / 1_000_000
  const x = (northing - 1_200_000) / 1_000_000
  const lonSec =
    2.6779094 +
    4.728982 * y +
    0.791484 * y * x +
    0.1306 * y * x * x -
    0.0436 * y * y * y
  const latSec =
    16.9023892 +
    3.238272 * x -
    0.270978 * y * y -
    0.002528 * x * x -
    0.0447 * y * y * x -
    0.014 * x * x * x
  return { lon: (lonSec * 100) / 36, lat: (latSec * 100) / 36 }
}

const BASINS = {
  A: { id: "A", name: "Rhine", sea: "North Sea" },
  B: { id: "B", name: "Rhône", sea: "Mediterranean" },
  C: { id: "C", name: "Po", sea: "Adriatic" },
  D: { id: "D", name: "Adige", sea: "Adriatic" },
  E: { id: "E", name: "Danube", sea: "Black Sea" },
}

const MASSIF_SEEDS = [
  { id: "bernese", name: "Bernese Alps", lat: 46.52, lon: 8.08 },
  { id: "valais", name: "Valais Alps", lat: 46.02, lon: 7.62 },
  { id: "gotthard", name: "Gotthard", lat: 46.58, lon: 8.48 },
  { id: "glarus", name: "Glarus Alps", lat: 46.84, lon: 8.95 },
  { id: "bernina", name: "Bernina", lat: 46.4, lon: 9.9 },
  { id: "silvretta", name: "Silvretta", lat: 46.86, lon: 10.05 },
  { id: "ticino", name: "Ticino Alps", lat: 46.42, lon: 8.62 },
]

const PREFERRED = new Map([
  ["Grosser Aletschgletscher", "Aletsch"],
  ["Rhonegletscher", "Rhône"],
  ["Vadret da Morteratsch", "Morteratsch"],
])

function shortName(name) {
  if (PREFERRED.has(name)) return PREFERRED.get(name)
  let s = name.trim()
  s = s.replace(/^Ghiacciaio\s+(Grande\s+di\s+|del\s+|della\s+|dei\s+|di\s+|d')/i, "")
  s = s.replace(/^Glacier\s+(des\s+|du\s+|de\s+la\s+|de\s+l'|d'|de\s+)/i, "")
  s = s.replace(/^Vadret\s+(da\s+|dal\s+|d'|della\s+)/i, "")
  s = s.replace(/^Vadrecc\s+di\s+/i, "")
  s = s.replace(/^Vedreit\s+da\s+/i, "")
  s = s.replace(/gletscher$/i, "")
  s = s.replace(/firn$/i, "")
  return s.trim() || name.trim()
}

function dist2(lat, lon, m) {
  const dlat = lat - m.lat
  const dlon = (lon - m.lon) * Math.cos((lat * Math.PI) / 180)
  return dlat * dlat + dlon * dlon
}

function nearestMassif(lat, lon) {
  let best = MASSIF_SEEDS[0]
  let bestD = Infinity
  for (const m of MASSIF_SEEDS) {
    const d = dist2(lat, lon, m)
    if (d < bestD) {
      bestD = d
      best = m
    }
  }
  return best.id
}

function dataRows(text) {
  return parseCSV(text).filter((r) => /^[A-E][A-Za-z0-9]+-/.test((r[1] || "").trim()))
}

const list = new Map()
for (const row of dataRows(raw("glacier_list.csv"))) {
  const name = row[0].trim()
  const id = row[1].trim()
  const e = Number(row[2])
  const n = Number(row[3])
  if (!Number.isFinite(e) || !Number.isFinite(n)) continue
  const { lat, lon } = lv95ToWgs(e, n)
  const area = row[4] === "None" || row[4] === "" ? null : Number(row[4])
  const areaYear = row[5] === "None" || row[5] === "" ? null : Number(row[5])
  const basin = id[0]
  list.set(id, {
    id,
    name,
    short: shortName(name),
    lat: Math.round(lat * 1e5) / 1e5,
    lon: Math.round(lon * 1e5) / 1e5,
    area: Number.isFinite(area) ? Math.round(area * 1000) / 1000 : null,
    areaYear: Number.isFinite(areaYear) ? areaYear : null,
    basin,
    massif: nearestMassif(lat, lon),
  })
}

const lengthById = new Map()
for (const row of dataRows(raw("lengthchange.csv"))) {
  const id = row[1].trim()
  const end = row[4]
  const dL = Number(row[6])
  if (!end || !Number.isFinite(dL)) continue
  const year = Number(end.slice(0, 4))
  if (!Number.isFinite(year)) continue
  if (!lengthById.has(id)) lengthById.set(id, new Map())
  const bucket = lengthById.get(id)
  bucket.set(year, (bucket.get(year) || 0) + dL)
}

const massById = new Map()
for (const row of dataRows(raw("massbalance_observation.csv"))) {
  const id = row[1].trim()
  const end = row[4]
  const ba = Number(row[7])
  if (!end || !Number.isFinite(ba)) continue
  const year = Number(end.slice(0, 4))
  if (!Number.isFinite(year)) continue
  if (!massById.has(id)) massById.set(id, new Map())
  const bucket = massById.get(id)
  if (!bucket.has(year)) bucket.set(year, { sum: 0, n: 0 })
  const cell = bucket.get(year)
  cell.sum += ba
  cell.n += 1
}

function seriesFrom(map, round) {
  if (!map || map.size < 5) return null
  const years = [...map.keys()].sort((a, b) => a - b)
  const y0 = years[0]
  const y1 = years[years.length - 1]
  const values = []
  for (let y = y0; y <= y1; y++) {
    if (!map.has(y)) values.push(null)
    else values.push(round(map.get(y)))
  }
  return { y0, values }
}

const glaciers = []
for (const g of list.values()) {
  const length = seriesFrom(lengthById.get(g.id), (v) => Math.round(v * 10) / 10)
  const massMap = massById.get(g.id)
  let mass = null
  if (massMap && massMap.size >= 5) {
    const rounded = new Map()
    for (const [year, cell] of massMap) rounded.set(year, cell.sum / cell.n)
    mass = seriesFrom(rounded, (v) => Math.round(v))
  }
  if (!length) continue
  glaciers.push({
    ...g,
    y0: length.y0,
    dl: length.values,
    b0: mass ? mass.y0 : null,
    ba: mass ? mass.values : null,
  })
}

glaciers.sort((a, b) => a.name.localeCompare(b.name, "de"))

const massifs = MASSIF_SEEDS.map((seed) => {
  const members = glaciers.filter((g) => g.massif === seed.id)
  if (!members.length) return null
  const lat = members.reduce((s, g) => s + g.lat, 0) / members.length
  const lon = members.reduce((s, g) => s + g.lon, 0) / members.length
  return {
    id: seed.id,
    name: seed.name,
    lat: Math.round(lat * 1e4) / 1e4,
    lon: Math.round(lon * 1e4) / 1e4,
    count: members.length,
  }
}).filter(Boolean)

function distPointSeg(p, a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len)))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

function douglasPeucker(points, eps) {
  if (points.length < 3) return points
  let maxD = 0
  let idx = 0
  const end = points.length - 1
  for (let i = 1; i < end; i++) {
    const d = distPointSeg(points[i], points[0], points[end])
    if (d > maxD) {
      maxD = d
      idx = i
    }
  }
  if (maxD > eps) {
    const left = douglasPeucker(points.slice(0, idx + 1), eps)
    const right = douglasPeucker(points.slice(idx), eps)
    return left.slice(0, -1).concat(right)
  }
  return [points[0], points[end]]
}

function simplifyRing(ring) {
  const open = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.slice(0, -1)
    : ring.slice()
  const simplified = douglasPeucker(open, 0.0045)
  const rounded = simplified.map(([lon, lat]) => [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4])
  rounded.push(rounded[0])
  return rounded
}

const geo = JSON.parse(raw("ch-country.geojson"))
const coordinates = geo.features[0].geometry.coordinates
const outline = simplifyRing(coordinates[0])
const holes = coordinates.slice(1).map(simplifyRing).filter((ring) => ring.length > 8)

const rivers = [
  {
    id: "rhone",
    basin: "B",
    name: "Rhône",
    path: [
      [8.4, 46.57],
      [8.22, 46.46],
      [7.99, 46.32],
      [7.6, 46.27],
      [7.36, 46.23],
      [6.85, 46.37],
      [6.15, 46.21],
    ],
  },
  {
    id: "rhine",
    basin: "A",
    name: "Rhine",
    path: [
      [8.67, 46.63],
      [9.05, 46.78],
      [9.53, 46.85],
      [9.44, 47.05],
      [9.4, 47.48],
      [8.64, 47.66],
      [8.23, 47.6],
      [7.59, 47.56],
    ],
  },
  {
    id: "aare",
    basin: "A",
    name: "Aare",
    path: [
      [8.2, 46.56],
      [8.05, 46.72],
      [7.63, 46.76],
      [7.45, 46.95],
      [7.6, 47.22],
      [8.04, 47.41],
      [8.23, 47.6],
    ],
  },
  {
    id: "reuss",
    basin: "A",
    name: "Reuss",
    path: [
      [8.56, 46.56],
      [8.52, 46.78],
      [8.34, 46.95],
      [8.31, 47.05],
      [8.23, 47.48],
    ],
  },
  {
    id: "inn",
    basin: "E",
    name: "Inn",
    path: [
      [9.7, 46.4],
      [9.85, 46.48],
      [10.02, 46.55],
      [10.35, 46.8],
    ],
  },
  {
    id: "ticino",
    basin: "C",
    name: "Ticino",
    path: [
      [8.58, 46.52],
      [8.72, 46.38],
      [8.95, 46.26],
      [9.02, 46.2],
      [8.8, 46.15],
    ],
  },
]

let yearMin = Infinity
let yearMax = -Infinity
for (const g of glaciers) {
  yearMin = Math.min(yearMin, g.y0)
  yearMax = Math.max(yearMax, g.y0 + g.dl.length - 1)
}

const usedBasins = [...new Set(glaciers.map((g) => g.basin))]
  .sort()
  .map((id) => BASINS[id] || { id, name: id, sea: "" })

const dataset = {
  yearMin,
  yearMax,
  outline,
  holes,
  basins: usedBasins,
  massifs,
  rivers,
  glaciers,
}

const out = join(root, "src/data/dataset.json")
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(dataset))

const watch = ["Grosser Aletschgletscher", "Gornergletscher", "Rhonegletscher", "Vadret da Morteratsch", "Silvrettagletscher", "Ghiacciaio del Basòdino"]
console.log(`glaciers ${glaciers.length}  years ${yearMin}–${yearMax}  outline ${outline.length}  holes ${holes.length}`)
console.log("basins", usedBasins.map((b) => `${b.id}:${b.name}:${glaciers.filter((g) => g.basin === b.id).length}`).join("  "))
console.log("massifs", massifs.map((m) => `${m.name}:${m.count}`).join("  "))
for (const name of watch) {
  const g = glaciers.find((item) => item.name === name)
  if (!g) {
    console.log("missing", name)
    continue
  }
  const total = g.dl.reduce((s, v) => s + (v || 0), 0)
  console.log(`${g.short.padEnd(14)} ${g.lat.toFixed(3)} ${g.lon.toFixed(3)}  ${g.basin}/${g.massif}  area ${g.area}  ΔL ${total.toFixed(0)} m  from ${g.y0}  mb ${g.ba ? g.ba.length : 0}`)
}
