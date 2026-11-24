import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import raw from "./data/dataset.json"
import { toWorld } from "./geo"
import {
  annual,
  cum,
  formatDelta,
  formatWater,
  lastYear,
  lengthKm,
  mass,
  passes,
  prepare,
  topLosses,
  yearStats,
  type Ice,
} from "./model"
import { GlacierView, type SceneHooks } from "./scene"
import type { Dataset, Projection, Screen } from "./types"

const data = raw as unknown as Dataset
const glaciers = prepare(data)
const LEVELS = [
  { name: "Land", zoom: 0.05 },
  { name: "Range", zoom: 0.4 },
  { name: "Glacier", zoom: 0.68 },
  { name: "Record", zoom: 0.9 },
] as const

function levelIndex(zoom: number) {
  if (zoom < 0.28) return 0
  if (zoom < 0.52) return 1
  if (zoom < 0.78) return 2
  return 3
}

const SceneOverlay = memo(function SceneOverlay({
  bind,
}: {
  bind: (els: { labels: HTMLDivElement; compass: HTMLDivElement }) => void
}) {
  const labels = useRef<HTMLDivElement>(null)
  const compass = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (labels.current && compass.current) bind({ labels: labels.current, compass: compass.current })
  }, [bind])
  return (
    <>
      <div className="labels" ref={labels} />
      <div className="compass" ref={compass} />
    </>
  )
})

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<GlacierView | null>(null)
  const [screen, setScreen] = useState<Screen>("landing")
  const [showLanding, setShowLanding] = useState(true)
  const [landingOn, setLandingOn] = useState(true)
  const [projection, setProjection] = useState<Projection>("2d")
  const [rivers, setRivers] = useState(false)
  const [notes, setNotes] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [year, setYear] = useState(data.yearMax)
  const [playing, setPlaying] = useState(false)
  const [zoom, setZoom] = useState(0.05)
  const [glacierId, setGlacierId] = useState<string | null>(null)
  const [massifId, setMassifId] = useState<string | null>(null)
  const [basin, setBasin] = useState("all")
  const [massOnly, setMassOnly] = useState(false)
  const [query, setQuery] = useState("")
  const [hoverId, setHoverId] = useState<string | null>(null)
  const entered = useRef(false)
  const overlayRef = useRef<{ labels: HTMLDivElement; compass: HTMLDivElement } | null>(null)
  const yearRef = useRef(year)
  yearRef.current = year

  const enter = useCallback(() => {
    if (entered.current) return
    entered.current = true
    setLandingOn(false)
    setScreen("explore")
    setProjection("3d")
    window.setTimeout(() => setShowLanding(false), 900)
  }, [])

  const home = useCallback(() => {
    entered.current = false
    setShowLanding(true)
    setLandingOn(true)
    setScreen("landing")
    setProjection("2d")
    setZoom(0.05)
    setGlacierId(null)
    setPlaying(false)
    setNotes(false)
    setFilterOpen(false)
  }, [])

  const bind = useCallback((els: { labels: HTMLDivElement; compass: HTMLDivElement }) => {
    overlayRef.current = els
    viewRef.current?.attach(els)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const view = new GlacierView(canvas, data, glaciers)
    viewRef.current = view
    const hooks: SceneHooks = {
      onZoom: (value) => setZoom(value),
      onFocus: (id) => {
        setGlacierId(id)
        if (id) {
          const found = glaciers.find((g) => g.id === id)
          if (found) setMassifId(found.massif)
        }
      },
      onHover: (id) => setHoverId(id),
      onMassif: (id) => setMassifId(id),
      onEnter: () => enter(),
    }
    view.setHooks(hooks)
    if (overlayRef.current) view.attach(overlayRef.current)
    return () => {
      view.dispose()
      viewRef.current = null
    }
  }, [enter])

  useEffect(() => {
    viewRef.current?.apply({
      screen,
      projection,
      rivers,
      year,
      zoom,
      glacierId,
      basin,
      massOnly,
      query,
    })
  }, [screen, projection, rivers, year, zoom, glacierId, basin, massOnly, query])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    let acc = 0
    const tick = (now: number) => {
      acc += ((now - last) / 1000) * 9
      last = now
      if (acc >= 1) {
        const step = Math.floor(acc)
        acc -= step
        const next = yearRef.current + step
        if (next >= data.yearMax) {
          setYear(data.yearMax)
          setPlaying(false)
        } else setYear(next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        if (event.key === "Escape") target.blur()
        return
      }
      if (screen === "landing") {
        if (event.key === "Enter" || event.key === " ") enter()
        return
      }
      if (event.key === "ArrowRight") {
        setPlaying(false)
        setYear((value) => Math.min(data.yearMax, value + (event.shiftKey ? 10 : 1)))
      } else if (event.key === "ArrowLeft") {
        setPlaying(false)
        setYear((value) => Math.max(data.yearMin, value - (event.shiftKey ? 10 : 1)))
      } else if (event.key === " ") {
        event.preventDefault()
        togglePlay()
      } else if (event.key === "1") setZoom(LEVELS[0].zoom)
      else if (event.key === "2") setZoom(LEVELS[1].zoom)
      else if (event.key === "3") setZoom(LEVELS[2].zoom)
      else if (event.key === "4") setZoom(LEVELS[3].zoom)
      else if (event.key === "n" || event.key === "N") setNotes((value) => !value)
      else if (event.key === "r" || event.key === "R") setRivers((value) => !value)
      else if (event.key === "v" || event.key === "V") {
        setProjection((value) => (value === "2d" ? "3d" : "2d"))
      } else if (event.key === "f" || event.key === "F") setFilterOpen((value) => !value)
      else if (event.key === "Escape") {
        if (notes || filterOpen) {
          setNotes(false)
          setFilterOpen(false)
        } else {
          const index = levelIndex(zoom)
          if (index === 0) home()
          else setZoom(LEVELS[index - 1].zoom)
        }
      } else if (event.key === "/") {
        event.preventDefault()
        setFilterOpen(true)
        document.getElementById("glacier-search")?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const togglePlay = () => {
    setPlaying((value) => {
      if (!value && year >= data.yearMax) setYear(data.yearMin)
      return !value
    })
  }

  const queryKey = query.trim().toLowerCase()
  const ok = useCallback(
    (g: Ice) => passes(g, basin, massOnly, queryKey),
    [basin, massOnly, queryKey],
  )
  const stats = useMemo(() => yearStats(glaciers, year, ok), [year, ok])
  const losses = useMemo(() => topLosses(glaciers, year, ok, 5), [year, ok])
  const selected = glaciers.find((g) => g.id === glacierId) ?? null
  const hovered = glaciers.find((g) => g.id === hoverId) ?? null
  const focus = selected ?? hovered
  const massif = data.massifs.find((item) => item.id === massifId) ?? null
  const level = levelIndex(zoom)

  return (
    <div className="app">
      <canvas ref={canvasRef} />
      <SceneOverlay bind={bind} />
      {showLanding && (
        <button className={`landing ${landingOn ? "on" : "off"}`} onClick={enter}>
          <span className="sw">Sw</span>
          <span className="iss">iss</span>
          <span className="glaciers">Glaciers</span>
          <span className="enter-hint">Scroll or click</span>
        </button>
      )}
      {screen === "explore" && (
        <Chrome
          projection={projection}
          rivers={rivers}
          notes={notes}
          filterOpen={filterOpen}
          year={year}
          playing={playing}
          zoom={zoom}
          level={level}
          basin={basin}
          massOnly={massOnly}
          query={query}
          stats={stats}
          losses={losses}
          focus={focus}
          selected={selected}
          massif={massif}
          ok={ok}
          onHome={home}
          onProjection={setProjection}
          onRivers={() => setRivers((value) => !value)}
          onNotes={() => setNotes((value) => !value)}
          onFilter={() => setFilterOpen((value) => !value)}
          onYear={(value) => {
            setPlaying(false)
            setYear(value)
          }}
          onPlay={togglePlay}
          onZoom={setZoom}
          onBasin={setBasin}
          onMassOnly={() => setMassOnly((value) => !value)}
          onQuery={setQuery}
          onPick={(id) => {
            const found = glaciers.find((g) => g.id === id)
            setGlacierId(id)
            if (found) setMassifId(found.massif)
            setZoom(0.68)
            setFilterOpen(false)
          }}
        />
      )}
    </div>
  )
}

type ChromeProps = {
  projection: Projection
  rivers: boolean
  notes: boolean
  filterOpen: boolean
  year: number
  playing: boolean
  zoom: number
  level: number
  basin: string
  massOnly: boolean
  query: string
  stats: ReturnType<typeof yearStats>
  losses: { g: Ice; loss: number }[]
  focus: Ice | null
  selected: Ice | null
  massif: Dataset["massifs"][number] | null
  ok: (g: Ice) => boolean
  onHome: () => void
  onProjection: (projection: Projection) => void
  onRivers: () => void
  onNotes: () => void
  onFilter: () => void
  onYear: (year: number) => void
  onPlay: () => void
  onZoom: (zoom: number) => void
  onBasin: (basin: string) => void
  onMassOnly: () => void
  onQuery: (query: string) => void
  onPick: (id: string) => void
}

function Chrome(props: ChromeProps) {
  return (
    <div className="chrome">
      <button className="pill brand" onClick={props.onHome}>
        <span>Swiss</span>Glacio
      </button>
      <div className="top-right">
        <div className="seg" role="group" aria-label="Projection">
          <button className={props.projection === "2d" ? "on" : ""} onClick={() => props.onProjection("2d")}>
            2d
          </button>
          <button className={props.projection === "3d" ? "on" : ""} onClick={() => props.onProjection("3d")}>
            3d
          </button>
        </div>
        <button className={`pill river ${props.rivers ? "on" : ""}`} onClick={props.onRivers}>
          <i />
          River system
        </button>
      </div>
      <nav className="ladder" aria-label="Distance">
        {LEVELS.map((item, index) => (
          <button key={item.name} className={props.level === index ? "on" : ""} onClick={() => props.onZoom(item.zoom)}>
            <i />
            <span>{item.name}</span>
          </button>
        ))}
      </nav>
      <Timeline year={props.year} playing={props.playing} onYear={props.onYear} onPlay={props.onPlay} />
      <MapCard
        year={props.year}
        level={props.level}
        selected={props.selected}
        massif={props.massif}
        stats={props.stats}
        ok={props.ok}
        onPick={props.onPick}
      />
      <Filter {...props} />
      <button className="notes-btn" onClick={props.onNotes}>
        Notes
      </button>
      {props.notes && (
        <aside className="notes panel">
          <Notes level={props.level} year={props.year} focus={props.focus} massif={props.massif} stats={props.stats} />
        </aside>
      )}
    </div>
  )
}

function Timeline({
  year,
  playing,
  onYear,
  onPlay,
}: {
  year: number
  playing: boolean
  onYear: (year: number) => void
  onPlay: () => void
}) {
  const track = useRef<HTMLDivElement>(null)
  const span = data.yearMax - data.yearMin
  const t = (year - data.yearMin) / span
  const scrub = (clientY: number) => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect) return
    const u = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
    onYear(Math.round(data.yearMin + u * span))
  }
  return (
    <div className="time">
      <p className="time-label">Time</p>
      <div
        className="time-track"
        ref={track}
        onPointerDown={(event) => {
          scrub(event.clientY)
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) scrub(event.clientY)
        }}
      >
        <i />
        <strong style={{ top: `${t * 100}%` }}>{year}</strong>
      </div>
      <button className="play" onClick={onPlay}>
        {playing ? "Pause" : "Play"}
      </button>
    </div>
  )
}

function MapCard({
  year,
  level,
  selected,
  massif,
  stats,
  ok,
  onPick,
}: {
  year: number
  level: number
  selected: Ice | null
  massif: Dataset["massifs"][number] | null
  stats: ReturnType<typeof yearStats>
  ok: (g: Ice) => boolean
  onPick: (id: string) => void
}) {
  const map = useMemo(() => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const ring = (points: [number, number][]) =>
      points
        .map(([lon, lat], index) => {
          const [x, z] = toWorld(lon, lat)
          const y = -z
          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x)
          minY = Math.min(minY, y)
          maxY = Math.max(maxY, y)
          return `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`
        })
        .join(" ")
    let d = `${ring(data.outline)} Z`
    for (const hole of data.holes) d += ` ${ring(hole)} Z`
    return {
      d,
      viewBox: `${minX - 1} ${minY - 1} ${maxX - minX + 2} ${maxY - minY + 2}`,
    }
  }, [])
  const basinOf = (id: string) => data.basins.find((item) => item.id === id)
  const title = selected ? selected.short : level === 1 && massif ? massif.name : "Switzerland"
  const eyebrow = selected ? "Glacier" : level === 1 ? "Range" : "Map"
  return (
    <section className="mapcard panel">
      <header>
        <p>{eyebrow}</p>
        <h2>{title}</h2>
      </header>
      <svg viewBox={map.viewBox} className="minimap" role="img" aria-label="Switzerland">
        <path d={map.d} />
        {glaciers.filter(ok).map((g) => (
          <circle
            key={g.id}
            cx={g.x}
            cy={-g.z}
            r={g.id === selected?.id ? 0.72 : Math.max(0.22, Math.sqrt(g.area ?? 0.4) * 0.12)}
            className={g.id === selected?.id ? "hot" : g.y0 <= year ? "known" : "wait"}
            onClick={() => onPick(g.id)}
          />
        ))}
      </svg>
      {selected ? (
        <GlacierReadout g={selected} year={year} basin={basinOf(selected.basin)?.name ?? ""} />
      ) : (
        <div className="counts">
          <p>
            <b>{stats.retreat}</b>
            <span>retreating</span>
          </p>
          <p>
            <b>{stats.still}</b>
            <span>still</span>
          </p>
          <p>
            <b>{stats.advance}</b>
            <span>advancing</span>
          </p>
        </div>
      )}
    </section>
  )
}

function GlacierReadout({ g, year, basin }: { g: Ice; year: number; basin: string }) {
  const known = year >= g.y0
  const delta = annual(g, year)
  const balance = mass(g, year)
  const lost = cum(g, year)
  return (
    <div className="readout">
      <p className="where">
        {basin}
        {g.area != null ? ` · ${g.area.toFixed(1)} km²` : ""}
      </p>
      <p className="figure">{known ? formatDelta(lost) : "No record yet"}</p>
      <p className="since">{known ? `since ${g.y0}` : `record begins ${g.y0}`}</p>
      <dl>
        <div>
          <dt>This year</dt>
          <dd>{delta == null ? "—" : formatDelta(delta)}</dd>
        </div>
        <div>
          <dt>Mass</dt>
          <dd>{balance == null ? "—" : formatWater(balance)}</dd>
        </div>
        <div>
          <dt>Length now</dt>
          <dd>{known ? `${lengthKm(g, year).toFixed(1)} km` : "—"}</dd>
        </div>
      </dl>
      <Spark g={g} year={year} />
    </div>
  )
}

function Spark({ g, year }: { g: Ice; year: number }) {
  const end = Math.min(year, lastYear(g))
  if (end <= g.y0) return null
  const values: number[] = []
  for (let y = g.y0; y <= end; y++) values.push(cum(g, y))
  const min = Math.min(...values, 0)
  const max = Math.max(...values, 0)
  const span = max - min || 1
  const d = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 240
      const y = 42 - ((value - min) / span) * 42
      return `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(" ")
  return (
    <svg className="spark" viewBox="0 0 240 42" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

function Filter(props: ChromeProps) {
  return (
    <div className="filter">
      {props.filterOpen && (
        <div className="filter-pop panel">
          <div className="chips">
            <button className={props.basin === "all" ? "on" : ""} onClick={() => props.onBasin("all")}>
              All
            </button>
            {data.basins.map((item) => (
              <button
                key={item.id}
                className={props.basin === item.id ? "on" : ""}
                onClick={() => props.onBasin(item.id)}
              >
                {item.name}
              </button>
            ))}
            <button className={props.massOnly ? "on" : ""} onClick={props.onMassOnly}>
              Mass balance
            </button>
          </div>
          <input
            id="glacier-search"
            value={props.query}
            placeholder="Search a glacier"
            onChange={(event) => props.onQuery(event.target.value)}
          />
          <ol>
            {props.losses.map(({ g, loss }) => (
              <li key={g.id}>
                <button onClick={() => props.onPick(g.id)}>
                  <span>{g.short}</span>
                  <b>{formatDelta(loss)}</b>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
      <button className="pill filter-btn" onClick={props.onFilter}>
        Filter
      </button>
    </div>
  )
}

function Notes({
  level,
  year,
  focus,
  massif,
  stats,
}: {
  level: number
  year: number
  focus: Ice | null
  massif: Dataset["massifs"][number] | null
  stats: ReturnType<typeof yearStats>
}) {
  const basin = focus ? data.basins.find((item) => item.id === focus.basin) : null
  let body: string
  if (level >= 3 && focus) {
    body = `Each band is one year of ${focus.name}. Burgundy is loss. The pale bands gained. Where a mass-balance series exists, the band is metres of water; otherwise it is the sign of that year’s length change. Drag to turn the core.`
  } else if (level >= 2 && focus) {
    const lost = formatDelta(cum(focus, year))
    body = `${focus.name} enters the record in ${focus.y0}. The pale tongue is that first length. The solid tongue is ${year}. The ground between them is ice that is no longer there: ${lost}. Absolute length is estimated from surveyed area, because the measurement itself is only the change.`
  } else if (level === 1) {
    body = `${massif ? massif.name : "This range"} is one cluster of the monitored glaciers. Come closer and a tongue becomes a single glacier. The rivers, if you turn them on, thicken with the share of glaciers retreating in that basin during ${year}.`
  } else {
    const share = stats.observed ? Math.round((stats.retreat / stats.observed) * 100) : 0
    body = `In ${year}, ${share}% of the glaciers with a measurement are retreating. Scroll to move from the country, to a range, to one tongue, to the yearly record. The same model changes what it is willing to show.`
  }
  return (
    <>
      <p className="eyebrow">Notes</p>
      <p>{body}</p>
      {basin && (
        <p>
          {basin.name} basin, draining toward the {basin.sea}.
        </p>
      )}
      <ul>
        <li>Scroll changes distance. 1–4 jump a level.</li>
        <li>Drag orbits. Right-drag or Shift-drag pans.</li>
        <li>V switches 2D and 3D. R draws the rivers.</li>
        <li>Arrows step the year. Space plays the record.</li>
      </ul>
      <p className="cite">
        Length change: GLAMOS (2025), doi:10.18750/lengthchange.2025.r2025. Mass balance: GLAMOS (2025),
        doi:10.18750/massbalance.2025.r2025. Positions from the GLAMOS glacier list. Outline simplified from
        swissBOUNDARIES3D. Relief and river lines are a model, not a survey.
      </p>
    </>
  )
}
