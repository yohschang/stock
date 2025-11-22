Here’s a compact but complete design doc you can actually build from.

⸻

1. Overview

We want a stock price line-alert system where:
	•	User can draw a line at any angle on a price chart (not just horizontal).
	•	The line is defined by user-chosen start & end points (t₁, p₁) and (t₂, p₂).
	•	The system computes the slope and auto-extends the line beyond the original segment (future feature).
	•	The system triggers an alert when price crosses the line.
	•	For the MVP, we use yfinance historical data and run this as a backtest / simulation (no real-time feed yet).

Target stack (suggested, can be changed):
	•	Backend: Python, FastAPI (or Flask), yfinance, simple DB (Postgres).
	•	Frontend: Web UI with a JS charting lib (e.g., TradingView Lightweight Charts / Plotly) that supports drawing custom lines.

⸻

2. Scope & Non-Goals

In scope (MVP)
	1.	Fetch historical OHLC price data (daily or intraday) using yfinance.
	2.	Display price chart for a chosen ticker and date range.
	3.	User draws a line segment:
	•	Selects start point on chart (time + price).
	•	Selects end point on chart.
	4.	System stores the line (with computed slope) and treats it as:
	•	For MVP: a finite segment between t₁ and t₂, plus optional simple extension beyond t₂ with the same slope.
	5.	System evaluates the historical data to detect line crosses.
	6.	Show:
	•	List of crossings (time, price, direction).
	•	Markers on chart at crossing points.

Future (not in MVP, but design should allow)
	•	True real-time data feed and live alerts.
	•	Rich alert conditions: “within X% of the line”, time-bounded alerts, multiple lines per chart.
	•	Per-user authentication, multi-asset watchlist.
	•	Auto-extend line into the future by default (infinite line model).

⸻

3. User Stories
	1.	Define line & run backtest
As a user, I select a ticker and date range, draw a line by clicking two points on the chart, and see when in the past the price would have crossed this line.
	2.	Inspect crossings
As a user, I want to see a table of all crossing events: date/time, price, and direction (price crossing from below to above or above to below).
	3.	Save line setup
As a user, I can save my drawn line so I can re-run backtests or (later) use the same line for real-time alerts.

⸻

4. High-Level Architecture

Frontend:
	•	Single-page app (React / Vue / plain JS).
	•	Uses a chart library to:
	•	Render OHLC candlesticks or line chart.
	•	Allow user to click/select two points → draw line overlay.
	•	Sends line definition + ticker + date range to backend for evaluation.
	•	Displays crossing results.

Backend (API):
	•	/price-data – fetch & cache historical price data via yfinance.
	•	/lines – CRUD for alert lines.
	•	/backtest-crossings – given a line & ticker & date range, compute crossings on historical data.

Data store:
	•	postgres:
	•	users (optional for MVP, can assume single user).
	•	symbols (id, symbol).
	•	lines (per line configuration).
	•	line_cross_events (optional, or just compute on the fly for MVP).

⸻

5. Core Model: Line Geometry

We model a line in time–price space.

5.1. Time representation
	•	Use POSIX timestamp (seconds since epoch) or a float in days.
	•	Let:
	•	t1 = start time (float / int)
	•	p1 = start price (float)
	•	t2 = end time
	•	p2 = end price

5.2. Slope & equation

Slope (price per unit time):

m = \frac{p2 - p1}{t2 - t1}

Given any time t, the line price is:

p_{line}(t) = p1 + m \cdot (t - t1)

For MVP, we can choose one of two behaviors:
	•	Segment only: Only consider line between t1 and t2.
	•	Extended line: For t >= t1 (or for all t), use the equation; ignore before t1 if we like.

We’ll design the data model so we can support both.

5.3. Data model (conceptual)

Line
- id (uuid)
- user_id
- symbol (string, e.g., "AAPL")
- t1 (datetime)
- p1 (float)
- t2 (datetime)
- p2 (float)
- slope (float)         // derived, but cached
- extend_mode (enum): {segment_only, extend_forward, extend_both}
- created_at
- is_active (bool)

Later we can add:
	•	t_end_valid for validity expiration.
	•	tolerance_pct or tolerance_abs for “close to line” alerts.

⸻

6. Alert / Crossing Detection Logic

Given:
	•	Historical price series: times t[i], prices close[i] (or high/low).
	•	Line function p_line(t).

We want to detect times when real price crosses the line.

6.1. Basic idea

For each interval [t[i], t[i+1]]:
	1.	Compute:
	•	d_i = price[i] - p_line(t[i])
	•	d_next = price[i+1] - p_line(t[i+1])
	2.	A sign change in d means a cross:
	•	d_i * d_next < 0 → crossing occurs somewhere between t[i] and t[i+1].
	•	If one is 0, treat it as touching the line.
	3.	Determine direction:
	•	If d_i < 0 and d_next > 0 → crossing from below (bullish).
	•	If d_i > 0 and d_next < 0 → crossing from above (bearish).

For more accuracy, we can approximate the exact crossing point by linear interpolation:

t_{cross} = t_i + (t_{i+1} - t_i) \cdot \frac{|d_i|}{|d_i| + |d_{next}|}

Then:

p_{cross} = p_{line}(t_{cross})

6.2. Using OHLC instead of close

Simpler MVP:
	•	Use close price per bar; we only detect crosses bar-to-bar.

More accurate (future):
	•	Use high/low:
	•	Check whether line value at t[i] lies between low[i] and high[i] etc.
	•	But this complicates interpolation; we can start with close-based.

⸻

7. API Design (MVP)

7.1. GET /price-data

Parameters:
	•	symbol: string (e.g. AAPL)
	•	start: ISO datetime
	•	end: ISO datetime
	•	interval: string (1d, 1h, 15m, etc.)

Behavior:
	•	Uses yfinance.download(symbol, start=start, end=end, interval=interval).
	•	Returns JSON array of bars: {time, open, high, low, close, volume}.
	•	Optionally caches results by symbol + timeframe + interval.

7.2. POST /lines

Request body:

{
  "symbol": "AAPL",
  "t1": "2023-01-01T10:00:00Z",
  "p1": 120.5,
  "t2": "2023-01-10T10:00:00Z",
  "p2": 130.0,
  "extend_mode": "extend_forward"  // or "segment_only"
}

Backend:
	•	Validates symbol exists.
	•	Converts t1, t2 to timestamps.
	•	Computes slope.
	•	Stores in DB.
	•	Returns line id and derived attributes.

7.3. POST /backtest-crossings

Request body:

{
  "line_id": "uuid-here",
  "start": "2022-12-01T00:00:00Z",
  "end": "2023-02-01T00:00:00Z",
  "interval": "1d"
}

Steps:
	1.	Load Line by line_id.
	2.	Fetch price data from /price-data (or directly via a service layer).
	3.	Iterate through bars i = 0..N-2:
	•	Compute p_line(t[i]), p_line(t[i+1]).
	•	Compute d_i, d_next.
	•	Check sign change.
	4.	Build array of crossing events:

[
  {
    "t_cross": "2023-01-05T14:32:00Z",
    "p_cross": 125.1,
    "direction": "up"   // or "down"
  },
  ...
]

	5.	Return JSON list.

Optionally, also return:
	•	Indices of the bars where it crossed.
	•	For convenience, we might just use t[i+1] and close[i+1] as approximate crossing.

⸻

8. Frontend Behavior

8.1. Drawing the line

Workflow:
	1.	User selects ticker + date range → frontend calls GET /price-data → renders chart.
	2.	User enters “draw line mode”:
	•	Click 1: record (t1, p1) from chart coordinates.
	•	Click 2: record (t2, p2) & draw a line overlay between these coordinates.
	3.	Frontend calls POST /lines with these four numbers.
	4.	Backend returns line_id and slope.
	5.	Frontend can now:
	•	Store the line as active.
	•	Optionally call /backtest-crossings automatically and display results.

8.2. Displaying crossings
	•	For each crossing returned:
	•	Add a marker (e.g., small triangle/point) at t_cross, p_cross.
	•	Show a tooltip: “Crossed line, direction: up, price: 125.1”.
	•	Add a list/table below chart:

#	Time	Price	Direction
1	2023-01-05 14:32:00	125.10	up
2	2023-01-12 10:00:00	128.75	down


⸻

9. Pseudo-Code (Backend Core)

9.1. Line model & constructor

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

ExtendMode = Literal["segment_only", "extend_forward", "extend_both"]

@dataclass
class Line:
    symbol: str
    t1: datetime
    p1: float
    t2: datetime
    p2: float
    extend_mode: ExtendMode

    @property
    def slope(self) -> float:
        dt = (self.t2.timestamp() - self.t1.timestamp())
        if dt == 0:
            raise ValueError("t1 and t2 cannot be equal")
        return (self.p2 - self.p1) / dt

    def price_at(self, t: datetime) -> float:
        dt = t.timestamp() - self.t1.timestamp()
        return self.p1 + self.slope * dt

    def is_time_in_range(self, t: datetime) -> bool:
        if self.extend_mode == "segment_only":
            return self.t1 <= t <= self.t2
        elif self.extend_mode == "extend_forward":
            return t >= self.t1
        elif self.extend_mode == "extend_both":
            return True

9.2. Crossing detection

def find_crossings(line: Line, bars):
    """
    bars: list of dicts: [{"time": datetime, "close": float}, ...]
    """
    crossings = []
    for i in range(len(bars) - 1):
        t_i = bars[i]["time"]
        t_j = bars[i+1]["time"]
        if not (line.is_time_in_range(t_i) or line.is_time_in_range(t_j)):
            # Optional optimization: skip if both outside and we only use segment
            continue

        p_i = bars[i]["close"]
        p_j = bars[i+1]["close"]

        l_i = line.price_at(t_i)
        l_j = line.price_at(t_j)

        d_i = p_i - l_i
        d_j = p_j - l_j

        # No cross if both on same side or one is NaN
        if d_i == 0 or d_j == 0:
            direction = "touch"
            crossings.append({
                "time": t_j.isoformat(),
                "price": p_j,
                "direction": direction
            })
            continue

        if d_i * d_j < 0:  # sign change
            # Approximate crossing via interpolation
            ratio = abs(d_i) / (abs(d_i) + abs(d_j))
            t_cross_ts = t_i.timestamp() + (t_j.timestamp() - t_i.timestamp()) * ratio
            from datetime import datetime
            t_cross = datetime.utcfromtimestamp(t_cross_ts)
            p_cross = line.price_at(t_cross)
            direction = "up" if d_i < 0 and d_j > 0 else "down"

            crossings.append({
                "time": t_cross.isoformat(),
                "price": p_cross,
                "direction": direction
            })
    return crossings


⸻

10. Future: Auto-Extended Line

Once MVP is stable, we can implement auto extension based on initial slope:
	•	For extend_forward: treat model as infinite ray starting at (t1, p1) going forward in time.
	•	For extend_both: infinite straight line.

That’s already supported conceptually by price_at(); we only need to adjust is_time_in_range() and maybe add UI to show extension to the right of the chart.

⸻

If you want, next step I can:
	•	Pick FastAPI and give you a minimal working backend skeleton with:
	•	/price-data
	•	/lines
	•	/backtest-crossings
	•	Or sketch the frontend interactions for Lightweight Charts specifically (how to convert click → time/price → API call).

---

Quickstart (updated for Vite + TradingView Lite + Postgres)

Backend (FastAPI)
1) Install deps (Python 3.10+):
   pip install -r requirements.txt
2) Ensure Postgres is running (default url used if env var is absent):
   DATABASE_URL=postgresql+psycopg2://postgres:postgres@0.0.0.0:5432/postgres
3) Run API + built frontend (after building):
   uvicorn backend.main:app --reload --port 8000

Frontend (Vite + Lightweight Charts)
1) cd frontend && npm install   # requires internet access
2) npm run dev                  # dev server on http://localhost:5173 (API must be on 8000)
3) npm run build                # outputs frontend/dist, which FastAPI will serve at http://localhost:8000/

Usage
- Inputs now accept date-only for start/end.
- Load price data, then click two points on the chart to create/save a line (persisted in Postgres) and auto-run the crossing backtest. Crossings render as markers and a table.
