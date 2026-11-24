export type Basin = {
  id: string
  name: string
  sea: string
}

export type Massif = {
  id: string
  name: string
  lat: number
  lon: number
  count: number
}

export type River = {
  id: string
  basin: string
  name: string
  path: [number, number][]
}

export type Glacier = {
  id: string
  name: string
  short: string
  lat: number
  lon: number
  area: number | null
  areaYear: number | null
  basin: string
  massif: string
  y0: number
  dl: (number | null)[]
  b0: number | null
  ba: (number | null)[] | null
}

export type Dataset = {
  yearMin: number
  yearMax: number
  outline: [number, number][]
  holes: [number, number][][]
  basins: Basin[]
  massifs: Massif[]
  rivers: River[]
  glaciers: Glacier[]
}

export type Screen = "landing" | "explore"
export type Projection = "2d" | "3d"

export type ViewState = {
  screen: Screen
  projection: Projection
  rivers: boolean
  year: number
  zoom: number
  glacierId: string | null
  basin: string
  massOnly: boolean
  query: string
}
