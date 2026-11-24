/* global Cesium */

const SWISS_RECTANGLE = Cesium.Rectangle.fromDegrees(5.9, 45.75, 10.55, 47.85);

const VIEWS = {
  overview: {
    destination: Cesium.Cartesian3.fromDegrees(8.15, 46.35, 185000),
    orientation: {
      heading: Cesium.Math.toRadians(20),
      pitch: Cesium.Math.toRadians(-55),
      roll: 0,
    },
  },
  aletsch: {
    destination: Cesium.Cartesian3.fromDegrees(7.92, 46.62, 28000),
    orientation: {
      heading: Cesium.Math.toRadians(155),
      pitch: Cesium.Math.toRadians(-32),
      roll: 0,
    },
  },
  matterhorn: {
    destination: Cesium.Cartesian3.fromDegrees(7.68, 46.08, 14000),
    orientation: {
      heading: Cesium.Math.toRadians(200),
      pitch: Cesium.Math.toRadians(-18),
      roll: 0,
    },
  },
};

const ICE = Cesium.Color.fromCssColorString("#7ec8ea").withAlpha(0.88);
const ICE_OUTLINE = Cesium.Color.fromCssColorString("#b9e6f7").withAlpha(0.95);

function createSolidImagery(cssColor) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, 64, 64);
  return new Cesium.SingleTileImageryProvider({
    url: canvas.toDataURL("image/png"),
    tileWidth: 64,
    tileHeight: 64,
  });
}

async function createViewer() {
  // Avoid Cesium Ion defaults — we use swisstopo only
  Cesium.Ion.defaultAccessToken = undefined;

  const terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(
    "https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1",
    { requestVertexNormals: true }
  );

  // Clay / paper look: solid apron + swissALTI3D hillshade (no road map clutter)
  const apron = createSolidImagery("#e6e3dc");
  const relief = new Cesium.UrlTemplateImageryProvider({
    url: "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissalti3d-reliefschattierung/default/current/3857/{z}/{x}/{y}.png",
    credit: "© swisstopo",
    maximumLevel: 16,
    rectangle: SWISS_RECTANGLE,
  });

  const viewer = new Cesium.Viewer("cesiumContainer", {
    terrainProvider,
    baseLayer: new Cesium.ImageryLayer(apron),
    animation: false,
    timeline: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    navigationHelpButton: false,
    infoBox: false,
    selectionIndicator: false,
    shadows: false,
    shouldAnimate: false,
  });

  viewer.imageryLayers.addImageryProvider(relief);

  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#e6e3dc");
  viewer.scene.globe.maximumScreenSpaceError = 1.5;
  viewer.scene.fog.enabled = true;
  viewer.scene.fog.density = 0.0002;
  viewer.scene.skyAtmosphere.hueShift = -0.05;
  viewer.scene.skyAtmosphere.saturationShift = -0.25;
  viewer.scene.skyAtmosphere.brightnessShift = -0.1;
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#d4d2cc");
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = 200;
  viewer.scene.screenSpaceCameraController.maximumZoomDistance = 420000;

  viewer.scene.verticalExaggeration = 1.2;

  return viewer;
}

function styleGlacierEntity(entity) {
  if (!entity.polygon) return;
  entity.polygon.material = ICE;
  entity.polygon.outline = true;
  entity.polygon.outlineColor = ICE_OUTLINE;
  entity.polygon.outlineWidth = 1;
  entity.polygon.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
  entity.polygon.classificationType = Cesium.ClassificationType.TERRAIN;
  entity.polygon.perPositionHeight = false;
  // Slight lift so ice reads clearly on ridges
  entity.polygon.extrudedHeight = undefined;
  entity.polygon.zIndex = 1;
}

function styleLabelEntity(entity, { fontSize = "12px", fill = "#e8e6e1", outline = "#2a2a2a" } = {}) {
  const name = entity.properties?.name?.getValue?.() ?? entity.name;
  if (!name) {
    entity.show = false;
    return;
  }
  entity.billboard = undefined;
  entity.point = undefined;
  entity.label = new Cesium.LabelGraphics({
    text: String(name),
    font: `600 ${fontSize} "Avenir Next", "Segoe UI", sans-serif`,
    fillColor: Cesium.Color.fromCssColorString(fill),
    outlineColor: Cesium.Color.fromCssColorString(outline),
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    pixelOffset: new Cesium.Cartesian2(0, -6),
    scaleByDistance: new Cesium.NearFarScalar(5e3, 1.15, 8e4, 0.55),
    translucencyByDistance: new Cesium.NearFarScalar(4e4, 1.0, 1.2e5, 0.0),
  });
}

function showInfo(entity) {
  const panel = document.getElementById("info");
  const title = document.getElementById("infoTitle");
  const body = document.getElementById("infoBody");
  const props = entity.properties;
  if (!props) return;

  const name = props.name?.getValue?.() || "Unnamed glacier";
  const rows = [
    ["SGI ID", props.sgi_id?.getValue?.()],
    ["Area", formatKm2(props.area_km2?.getValue?.())],
    ["Length", formatKm(props.length_km?.getValue?.())],
    ["Elev. min", formatM(props.masl_min?.getValue?.())],
    ["Elev. mean", formatM(props.masl_mean?.getValue?.())],
    ["Elev. max", formatM(props.masl_max?.getValue?.())],
    ["Acquired", props.year_acq?.getValue?.()],
  ].filter(([, v]) => v != null && v !== "");

  title.textContent = name;
  body.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  panel.classList.remove("hidden");
}

function formatKm2(v) {
  if (v == null || Number.isNaN(Number(v))) return null;
  return `${Number(v).toFixed(2)} km²`;
}

function formatKm(v) {
  if (v == null || Number.isNaN(Number(v))) return null;
  return `${Number(v).toFixed(2)} km`;
}

function formatM(v) {
  if (v == null || Number.isNaN(Number(v))) return null;
  return `${Math.round(Number(v))} m`;
}

function flyTo(viewer, key) {
  const view = VIEWS[key];
  if (!view) return;
  viewer.camera.flyTo({ ...view, duration: 2.2 });
}

async function main() {
  const loading = document.getElementById("loading");
  const viewer = await createViewer();

  const [glaciers, glacierLabels, places] = await Promise.all([
    Cesium.GeoJsonDataSource.load("./public/data/glaciers.geojson", {
      clampToGround: true,
    }),
    Cesium.GeoJsonDataSource.load("./public/data/glacier-labels.geojson", {
      clampToGround: true,
    }),
    Cesium.GeoJsonDataSource.load("./public/data/places.geojson", {
      clampToGround: true,
    }),
  ]);

  glaciers.name = "glaciers";
  glaciers.entities.values.forEach(styleGlacierEntity);
  await viewer.dataSources.add(glaciers);

  glacierLabels.name = "glacier-labels";
  glacierLabels.entities.values.forEach((e) =>
    styleLabelEntity(e, { fontSize: "11px", fill: "#c9eaf7" })
  );
  await viewer.dataSources.add(glacierLabels);

  places.name = "places";
  places.entities.values.forEach((e) => {
    const kind = e.properties?.kind?.getValue?.();
    const size = kind === "peak" || kind === "glacier" ? "13px" : "12px";
    const fill = kind === "lake" ? "#b8c4ce" : "#eceae4";
    styleLabelEntity(e, { fontSize: size, fill });
  });
  await viewer.dataSources.add(places);

  // Click glacier → info panel
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.position);
    if (!Cesium.defined(picked) || !picked.id) {
      document.getElementById("info").classList.add("hidden");
      return;
    }
    const entity = picked.id;
    if (entity.polygon) showInfo(entity);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  document.getElementById("toggleGlaciers").addEventListener("change", (e) => {
    glaciers.show = e.target.checked;
  });
  document.getElementById("toggleLabels").addEventListener("change", (e) => {
    glacierLabels.show = e.target.checked;
    places.show = e.target.checked;
  });
  document.getElementById("exaggeration").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    viewer.scene.verticalExaggeration = v;
    document.getElementById("exaggerationValue").textContent = `${v.toFixed(1)}×`;
  });
  document.getElementById("flyAletsch").addEventListener("click", () => flyTo(viewer, "aletsch"));
  document.getElementById("flyMatterhorn").addEventListener("click", () => flyTo(viewer, "matterhorn"));
  document.getElementById("flyOverview").addEventListener("click", () => flyTo(viewer, "overview"));
  document.getElementById("closeInfo").addEventListener("click", () => {
    document.getElementById("info").classList.add("hidden");
  });

  viewer.camera.setView(VIEWS.aletsch);
  loading.classList.add("done");
}

main().catch((err) => {
  console.error(err);
  const loading = document.getElementById("loading");
  loading.innerHTML = `<p style="color:#f5a8a8;max-width:320px;text-align:center">Failed to load.<br/>${err.message}</p>`;
});
