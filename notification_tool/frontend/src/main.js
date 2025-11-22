import "./style.css";
import { createChart } from "lightweight-charts";

const app = document.getElementById("app");

app.innerHTML = `
  <header>Line Alert Backtester</header>
  <main>
    <section>
      <h3 style="margin-top:0;">Parameters</h3>
      <label for="symbol">Symbol</label>
      <input id="symbol" value="AAPL" />

      <label for="start">Start date</label>
      <input id="start" type="date" />

      <label for="end">End date</label>
      <input id="end" type="date" />

      <label for="interval">Interval</label>
      <select id="interval">
        <option value="1d">1 day</option>
        <option value="1h">1 hour</option>
        <option value="30m">30 min</option>
        <option value="15m">15 min</option>
      </select>

      <label for="mode">Draw mode</label>
      <select id="mode">
        <option value="slope">Slope (2 clicks)</option>
        <option value="horizontal">Horizontal (1 click)</option>
      </select>

      <label for="extend">Extend mode</label>
      <select id="extend">
        <option value="extend_forward">Extend forward</option>
        <option value="segment_only">Segment only</option>
        <option value="extend_both">Extend both</option>
      </select>

      <button id="load">Load price data</button>
      <button id="zoom">Auto zoom to data</button>
      <p class="muted">After the chart renders, click two points to define your alert line. It will be saved and backtested automatically.</p>
      <div class="status"><span></span><div id="status-text">Idle</div></div>
    </section>

<section>
  <div id="chart"></div>
  <div id="info" class="muted" style="margin-top:8px;"></div>
  <div id="markers"></div>
  <div style="margin-top:12px; display:flex; gap:8px; align-items:center;">
    <button id="clear-lines" style="flex:0 0 auto;">Clear all lines</button>
    <div class="muted" style="font-size:12px;">Active lines</div>
  </div>
  <div id="lines-panel" style="margin-top:8px;"></div>
</section>
  </main>
`;

const statusEl = document.getElementById("status-text");
const infoEl = document.getElementById("info");
const symbolEl = document.getElementById("symbol");
const startEl = document.getElementById("start");
const endEl = document.getElementById("end");
const intervalEl = document.getElementById("interval");
const modeEl = document.getElementById("mode");
const extendEl = document.getElementById("extend");
const markersEl = document.getElementById("markers");
const linesPanelEl = document.getElementById("lines-panel");

let priceData = [];
let crossings = [];
let clickPoints = [];
let currentLine = null;
let clickMarkers = [];
let lineSeriesMap = new Map();
let lineMeta = new Map();
let dragging = null;

const linePalette = ["#61dafb", "#7c4dff", "#f6c177", "#7ee787", "#ff9e64", "#ffa7c4"];
let colorIdx = 0;

function nextColor() {
  const c = linePalette[colorIdx % linePalette.length];
  colorIdx += 1;
  return c;
}

const chart = createChart(document.getElementById("chart"), {
  layout: { background: { color: "transparent" }, textColor: "#e6edf3" },
  grid: {
    vertLines: { color: "rgba(255,255,255,0.05)" },
    horzLines: { color: "rgba(255,255,255,0.05)" },
  },
  height: 560,
  timeScale: { borderVisible: false },
  rightPriceScale: { borderVisible: false },
  crosshair: {
    vertLine: { visible: false },
    horzLine: { visible: false },
  },
});

const candleSeries = chart.addCandlestickSeries({
  upColor: "#7ee787",
  downColor: "#f78c6c",
  borderUpColor: "#7ee787",
  borderDownColor: "#f78c6c",
  wickUpColor: "#7ee787",
  wickDownColor: "#f78c6c",
});

const draftLineSeries = chart.addLineSeries({
  color: "#61dafb",
  lineWidth: 1,
  lineStyle: 1,
  priceLineVisible: false,
  lastValueVisible: false,
});

function setDefaults() {
  const today = new Date();
  const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  startEl.valueAsDate = monthAgo;
  endEl.valueAsDate = today;
}

function status(msg) {
  statusEl.textContent = msg;
}

function toISODate(inputEl) {
  return inputEl.value ? inputEl.value : null;
}

function toTimestampSeconds(isoString) {
  if (!isoString) return null;
  if (typeof isoString === "string" && !isoString.endsWith("Z") && !isoString.includes("+")) {
    isoString += "Z";
  }
  return Math.floor(new Date(isoString).getTime() / 1000);
}

function normalizeParamTime(time) {
  if (typeof time === "number") {
    return new Date(time * 1000);
  }
  if (time && typeof time === "object" && "year" in time) {
    return new Date(Date.UTC(time.year, time.month - 1, time.day));
  }
  return null;
}

function toSeconds(value) {
  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000);
  }
  if (typeof value === "number") {
    return value;
  }
  if (value && typeof value === "object" && "year" in value) {
    return Math.floor(Date.UTC(value.year, value.month - 1, value.day) / 1000);
  }
  const normalized = normalizeParamTime(value);
  return normalized ? Math.floor(normalized.getTime() / 1000) : null;
}

function ensureDistinctTimestamps(payload) {
  const t1 = new Date(payload.t1).getTime();
  const t2 = new Date(payload.t2).getTime();
  if (t1 === t2) {
    payload.t2 = new Date(t2 + 1000).toISOString();
  }
  return payload;
}

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const chartContainer = document.getElementById("chart");

let isLoading = false;

function chartTimeBounds() {
  const data = candleSeries.data();
  if (!data.length) return null;
  return {
    from: toSeconds(data[0].time),
    to: toSeconds(data[data.length - 1].time),
  };
}

function visibleRangeSeconds() {
  const logicalRange = chart.timeScale().getVisibleLogicalRange();
  const data = candleSeries.data();
  if (!logicalRange || data.length < 2) return null;

  const firstLogical = chart.timeScale().timeToLogical(data[0].time);
  const lastLogical = chart.timeScale().timeToLogical(data[data.length - 1].time);
  const firstSec = toSeconds(data[0].time);
  const lastSec = toSeconds(data[data.length - 1].time);

  if (
    firstLogical === null ||
    lastLogical === null ||
    firstSec === null ||
    lastSec === null ||
    lastLogical === firstLogical
  ) {
    return null;
  }

  const secondsPerLogical = (lastSec - firstSec) / (lastLogical - firstLogical);
  return {
    from: firstSec + (logicalRange.from - firstLogical) * secondsPerLogical,
    to: firstSec + (logicalRange.to - firstLogical) * secondsPerLogical,
  };
}

function paddingSeconds() {
  const bounds = chartTimeBounds();
  if (!bounds) return 60 * 60; // 1 hour fallback
  const span = Math.max(bounds.to - bounds.from, 1);
  return Math.max(60 * 60, Math.floor(span * 0.1));
}

function priceOnLine(line, targetSeconds) {
  const t1 = toTimestampSeconds(line.t1);
  const t2 = toTimestampSeconds(line.t2);
  if (t1 === t2) return line.p1;
  const slope = (line.p2 - line.p1) / (t2 - t1);
  return line.p1 + slope * (targetSeconds - t1);
}

function renderLinePoints(line) {
  const t1 = toTimestampSeconds(line.t1);
  const t2 = toTimestampSeconds(line.t2);
  const start = Math.min(t1, t2);
  const end = Math.max(t1, t2);
  const visibleRange = visibleRangeSeconds();
  const bounds = chartTimeBounds();
  const pad = paddingSeconds();

  const fromVisible = visibleRange?.from ?? bounds?.from ?? start;
  const toVisible = visibleRange?.to ?? bounds?.to ?? end;

  let renderStart = start;
  let renderEnd = end;

  if (line.extend_mode === "extend_forward") {
    renderEnd = (toVisible ?? end) + pad;
  } else if (line.extend_mode === "extend_both") {
    renderStart = (fromVisible ?? start) - pad;
    renderEnd = (toVisible ?? end) + pad;
  }

  return [
    { time: renderStart, value: priceOnLine(line, renderStart) },
    { time: renderEnd, value: priceOnLine(line, renderEnd) },
  ];
}

function refreshRenderedLines() {
  lineSeriesMap.forEach((data, id) => {
    const meta = lineMeta.get(id);
    if (!meta) return;
    const points = renderLinePoints(meta);
    data.series.setData(points);
    const markers = lineMarkers(meta, data.crossings || [], data.color);
    data.series.setMarkers(markers);
  });
}

function applyTimeScalePadding() {
  const data = candleSeries.data();
  if (!data.length) return;
  const pad = Math.max(10, Math.floor(data.length * 0.2));
  chart.timeScale().applyOptions({
    leftOffset: Math.min(pad, 20),
    rightOffset: pad,
  });
}

async function loadPriceData() {
  if (isLoading) return;
  const loadBtn = document.getElementById("load");

  try {
    isLoading = true;
    loadBtn.disabled = true;
    loadBtn.textContent = "Loading...";

    const symbol = symbolEl.value.trim().toUpperCase();
    const start = toISODate(startEl);
    const end = toISODate(endEl);
    const interval = intervalEl.value;
    if (!symbol || !start || !end) {
      alert("Please enter symbol, start date, and end date.");
      return;
    }
    status("Loading price data...");
    const params = new URLSearchParams({ symbol, start, end, interval });
    const res = await fetch(`${API_BASE}/price-data?${params.toString()}`);
    if (!res.ok) {
      status("Failed to load price data");
      alert("Backend did not return data. Make sure the API is running.");
      return;
    }
    priceData = await res.json();
    const candles = priceData.map((bar) => ({
      time: toTimestampSeconds(bar.time),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    }));
    candleSeries.setData(candles);
    chart.timeScale().fitContent();
    applyTimeScalePadding();
    clickPoints = [];
    currentLine = null;
    crossings = [];
    clickMarkers = [];

    // Ensure we clean up old series properly
    lineSeriesMap.forEach(({ series }) => chart.removeSeries(series));
    lineSeriesMap.clear();
    lineMeta.clear();
    colorIdx = 0;

    draftLineSeries.setData([]);
    candleSeries.setMarkers([]);
    linesPanelEl.innerHTML = "";
    infoEl.textContent = `Loaded ${priceData.length} bars for ${symbol} (${interval})`;

    // Load existing lines for this symbol
    await fetchLines();

    status("Click two points on the chart to draw a line");
  } finally {
    isLoading = false;
    loadBtn.disabled = false;
    loadBtn.textContent = "Load price data";
  }
}

async function fetchLines() {
  const res = await fetch(`${API_BASE}/lines`);
  if (!res.ok) return;
  const lines = await res.json();
  const symbol = symbolEl.value.trim().toUpperCase();

  for (const line of lines) {
    if (line.symbol === symbol) {
      await runBacktest(line);
    }
  }
}

function buildPayloadFromMode() {
  const symbol = symbolEl.value.trim().toUpperCase();
  const mode = modeEl.value;
  if (mode === "horizontal") {
    if (!clickPoints.length) return null;
    const price = clickPoints[0].price;
    const times = candleSeries.data();
    if (!times.length) return null;
    const t1 = new Date(times[0].time * 1000);
    const t2 = new Date(times[times.length - 1].time * 1000);
    return ensureDistinctTimestamps({
      symbol,
      t1: t1.toISOString(),
      p1: price,
      t2: t2.toISOString(),
      p2: price,
      extend_mode: extendEl.value,
    });
  }
  if (clickPoints.length < 2) return null;
  const [a, b] = clickPoints;
  return ensureDistinctTimestamps({
    symbol,
    t1: a.time.toISOString(),
    p1: a.price,
    t2: b.time.toISOString(),
    p2: b.price,
    extend_mode: extendEl.value,
  });
}

async function createLine() {
  const payload = buildPayloadFromMode();
  if (!payload) return;
  status("Creating line...");
  const res = await fetch(`${API_BASE}/lines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    status("Line creation failed");
    alert("Could not create line. Check API logs.");
    return;
  }
  currentLine = await res.json();
  status("Line saved. Running backtest...");
  await runBacktest(currentLine);
}

async function runBacktest(line) {
  const start = toISODate(startEl);
  const end = toISODate(endEl);
  const interval = intervalEl.value;
  const res = await fetch(`${API_BASE}/backtest-crossings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ line_id: line.id, start, end, interval }),
  });

  let crossingsForLine = [];
  if (res.ok) {
    crossingsForLine = await res.json();
  } else {
    console.error("Backtest failed for line", line.id);
  }

  // If this is the currently created line, update global crossings
  if (currentLine && currentLine.id === line.id) {
    crossings = crossingsForLine;
    // renderCrossingTable(); // Removed

    status(`Found ${crossings.length} crossings`);
  }

  addLineToList(line, crossingsForLine);
}

// renderCrossingTable removed


function updateClickMarkers() {
  draftLineSeries.setMarkers(clickMarkers);
}

function lineMarkers(line, crossings, color) {
  const markers = [];
  // Add endpoints
  markers.push({
    time: toTimestampSeconds(line.t1),
    position: "inBar",
    color: color,
    shape: "circle",
    text: "P1",
    size: 1,
  });
  markers.push({
    time: toTimestampSeconds(line.t2),
    position: "inBar",
    color: color,
    shape: "circle",
    text: "P2",
    size: 1,
  });

  // Add crossings
  crossings.forEach((c) => {
    markers.push({
      time: toTimestampSeconds(c.time),
      position: c.direction === "up" ? "belowBar" : "aboveBar",
      color: c.direction === "up" ? "#7ee787" : color,
      shape: c.direction === "up" ? "arrowUp" : "arrowDown",
      text: c.direction,
    });
  });
  return markers;
}

function addLineToList(line, crossingsForLine) {
  // If line already exists, remove it first (to update)
  if (lineSeriesMap.has(line.id)) {
    const old = lineSeriesMap.get(line.id);
    chart.removeSeries(old.series);
    lineSeriesMap.delete(line.id);
  }

  const color = nextColor();
  const series = chart.addLineSeries({
    color,
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
  });
  const points = renderLinePoints(line);
  series.setData(points);

  const markers = lineMarkers(line, crossingsForLine, color);
  series.setMarkers(markers);

  lineSeriesMap.set(line.id, { series, color, crossings: crossingsForLine });
  lineMeta.set(line.id, line);
  renderLineList();
}

async function deleteLine(id) {
  const meta = lineSeriesMap.get(id);
  if (meta) {
    chart.removeSeries(meta.series);
  }
  lineSeriesMap.delete(id);
  lineMeta.delete(id);
  renderLineList();
  await fetch(`${API_BASE}/lines/${id}`, { method: "DELETE" }).catch(() => { });
}

async function clearAllLines() {
  lineSeriesMap.forEach(({ series }) => chart.removeSeries(series));
  lineSeriesMap.clear();
  lineMeta.clear();
  crossings = [];
  currentLine = null;
  dragging = null;
  colorIdx = 0;
  clickPoints = [];
  clickMarkers = [];
  draftLineSeries.setData([]);
  draftLineSeries.setMarkers([]);
  renderLineList();
  await fetch(`${API_BASE}/lines`, { method: "DELETE" }).catch(() => { });
}

function renderLineList() {
  if (!lineSeriesMap.size) {
    linesPanelEl.innerHTML = "<p class='muted' style='padding:8px;'>No lines active.</p>";
    return;
  }
  const items = Array.from(lineSeriesMap.entries())
    .map(([id, data]) => {
      const meta = lineMeta.get(id);
      if (!meta) return "";
      return `
        <div class="line-item">
          <div class="line-color" style="background-color:${data.color}"></div>
          <div class="line-info">
            <div class="line-symbol">${meta.symbol} <span style="font-weight:400; color:var(--muted); margin-left:4px;">${meta.extend_mode.replace("_", " ")}</span></div>
            <div class="line-dates">
              ${new Date(meta.t1).toLocaleDateString()} → ${new Date(meta.t2).toLocaleDateString()}
            </div>
          </div>
          <div class="line-actions">
            <button class="icon-btn" data-edit="${id}" title="Edit Settings">
              <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
            </button>
            <button class="icon-btn delete" data-delete="${id}" title="Delete Line">
              <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </div>
      `;
    })
    .join("");
  linesPanelEl.innerHTML = items;
}

function setDragging(id, endpoint) {
  dragging = { id, endpoint };
  status(`Dragging ${endpoint} of line`);
}

function updateLineDuringDrag(pt) {
  const meta = lineMeta.get(dragging.id);
  const seriesData = lineSeriesMap.get(dragging.id);
  if (!meta || !seriesData) return;
  const updated = { ...meta };
  if (dragging.endpoint === "p1") {
    updated.t1 = pt.time.toISOString();
    updated.p1 = pt.price;
  } else {
    updated.t2 = pt.time.toISOString();
    updated.p2 = pt.price;
  }
  lineMeta.set(dragging.id, updated);
  seriesData.crossings = [];
  const points = renderLinePoints(updated);
  seriesData.series.setData(points);

  const markers = lineMarkers(updated, [], seriesData.color);
  seriesData.series.setMarkers(markers);
}

async function applyDrag(pt) {
  updateLineDuringDrag(pt);
  const meta = lineMeta.get(dragging.id);
  if (!meta) {
    dragging = null;
    return;
  }
  await fetch(`${API_BASE}/lines/${dragging.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      t1: meta.t1,
      p1: meta.p1,
      t2: meta.t2,
      p2: meta.p2,
      extend_mode: meta.extend_mode,
    }),
  }).catch(() => { });
  dragging = null;
  status("Line updated. Re-running backtest...");
  await runBacktest(meta);
}

function pointFromCoords(x, y) {
  let timeVal = chart.timeScale().coordinateToTime(x);
  let priceVal = candleSeries.coordinateToPrice(y);
  if (priceVal === undefined || priceVal === null) {
    const priceScale = chart.priceScale("right");
    priceVal = priceScale.coordinateToPrice(y);
  }

  if (timeVal === null || timeVal === undefined) {
    const logical = chart.timeScale().coordinateToLogical(x);
    const data = candleSeries.data();
    if (logical !== null && data.length >= 2) {
      const firstLogical = chart.timeScale().timeToLogical(data[0].time);
      const lastLogical = chart.timeScale().timeToLogical(data[data.length - 1].time);
      if (firstLogical !== null && lastLogical !== null && lastLogical !== firstLogical) {
        const fraction = (logical - firstLogical) / (lastLogical - firstLogical);
        const firstSec = toSeconds(data[0].time);
        const lastSec = toSeconds(data[data.length - 1].time);
        if (firstSec !== null && lastSec !== null) {
          timeVal = firstSec + fraction * (lastSec - firstSec);
        }
      }
    }
  }

  if (timeVal === null || timeVal === undefined || priceVal === undefined || priceVal === null) return null;

  if (typeof timeVal === "number") {
    timeVal = new Date(timeVal * 1000);
  } else if (typeof timeVal === "object" && "year" in timeVal) {
    timeVal = new Date(Date.UTC(timeVal.year, timeVal.month - 1, timeVal.day));
  }

  return { time: timeVal, price: priceVal };
}

function handlePointerMove(event) {
  const rect = chartContainer.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const pt = pointFromCoords(x, y);

  if (dragging && dragging.id) {
    if (pt) {
      updateLineDuringDrag(pt);
    }
    return;
  }

  // If not dragging, show draft line if we have one point
  if (!priceData.length || clickPoints.length !== 1) {
    draftLineSeries.setData([]);
    draftLineSeries.setMarkers([]);
    return;
  }

  if (!pt) return;
  const first = clickPoints[0];
  draftLineSeries.setData([
    { time: toTimestampSeconds(first.time), value: first.price },
    { time: toTimestampSeconds(pt.time), value: pt.price },
  ]);
  // [FIX] Ensure markers stay visible
  updateClickMarkers();
}

function handlePointerDown(event) {
  if (event.button !== 0) return; // Only left click

  const rect = chartContainer.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const HIT_RADIUS = 20;

  // Check existing lines for hit
  for (const [id, meta] of lineMeta.entries()) {
    const seriesData = lineSeriesMap.get(id);
    if (!seriesData) continue;

    const t1c = chart.timeScale().timeToCoordinate(toTimestampSeconds(meta.t1));
    const t2c = chart.timeScale().timeToCoordinate(toTimestampSeconds(meta.t2));
    const p1c = seriesData.series.priceToCoordinate(meta.p1);
    const p2c = seriesData.series.priceToCoordinate(meta.p2);

    if (t1c !== null && p1c !== null) {
      const dist1 = Math.hypot(x - t1c, y - p1c);
      if (dist1 < HIT_RADIUS) {
        setDragging(id, "p1");
        chartContainer.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
    }

    if (t2c !== null && p2c !== null) {
      const dist2 = Math.hypot(x - t2c, y - p2c);
      if (dist2 < HIT_RADIUS) {
        setDragging(id, "p2");
        chartContainer.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
    }
  }
}

async function handlePointerUp(event) {
  const rect = chartContainer.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const pt = pointFromCoords(x, y);

  if (dragging) {
    if (pt) {
      await applyDrag(pt);
    }
    dragging = null;
    chartContainer.releasePointerCapture(event.pointerId);
    return;
  }

  // If not dragging, treat as a click for drawing
  if (!priceData.length) return;
  clickPoints.push(pt);
  const mode = modeEl.value;
  const markerTime = toTimestampSeconds(pt.time);
  const marker = {
    time: markerTime,
    position: "inBar",
    color: "#61dafb",
    shape: "circle",
    text: clickPoints.length === 1 ? "P1" : "P2",
    size: 1,
  };
  clickMarkers = [...clickMarkers, marker];
  updateClickMarkers();

  // [FIX] Immediately show the point on the draft line so it doesn't wait for a move event
  if (clickPoints.length === 1) {
    draftLineSeries.setData([
      { time: markerTime, value: pt.price },
      { time: markerTime, value: pt.price },
    ]);
  }

  fetch(`${API_BASE}/click-log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      time: pt.time.toISOString(),
      price: pt.price,
      mode,
      point_index: clickPoints.length,
    }),
  }).catch(() => { });

  if (mode === "horizontal") {
    status("Horizontal line point captured. Submitting...");
    createLine();
    clickPoints = [];
    draftLineSeries.setData([]);
    clickMarkers = [];
    updateClickMarkers();
    return;
  }

  status(`Point ${clickPoints.length} captured${clickPoints.length === 2 ? ". Submitting..." : " — move mouse to position P2"}`);

  if (clickPoints.length === 2) {
    draftLineSeries.setData([]);
    createLine();
    clickPoints = [];
    clickMarkers = [];
    updateClickMarkers();
  }
}

chart.timeScale().subscribeVisibleTimeRangeChange(() => {
  refreshRenderedLines();
});

chartContainer.addEventListener("pointermove", handlePointerMove);
chartContainer.addEventListener("pointerdown", handlePointerDown);
chartContainer.addEventListener("pointerup", handlePointerUp);

document.getElementById("load").addEventListener("click", loadPriceData);
document.getElementById("zoom").addEventListener("click", () => {
  chart.timeScale().fitContent();
  applyTimeScalePadding();
});
document.getElementById("clear-lines").addEventListener("click", clearAllLines);
linesPanelEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  const deleteId = btn.getAttribute("data-delete");
  if (deleteId) {
    deleteLine(deleteId);
    return;
  }

  const editId = btn.getAttribute("data-edit");
  if (editId) {
    editLineSettings(editId);
  }
});

async function editLineSettings(id) {
  const meta = lineMeta.get(id);
  if (!meta) return;

  const modes = ["segment_only", "extend_forward", "extend_both"];
  const currentIdx = modes.indexOf(meta.extend_mode);
  const nextMode = modes[(currentIdx + 1) % modes.length];

  // Optimistic update
  const updated = { ...meta, extend_mode: nextMode };
  lineMeta.set(id, updated);
  renderLineList();
  refreshRenderedLines();

  await fetch(`${API_BASE}/lines/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      t1: updated.t1,
      p1: updated.p1,
      t2: updated.t2,
      p2: updated.p2,
      extend_mode: updated.extend_mode,
    }),
  }).catch(() => { });

  status(`Updated to ${nextMode}. Re-running backtest...`);
  await runBacktest(updated);
}
setDefaults();
status("Ready");
