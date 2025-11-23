# Draw Line Playground

A Plotly-powered demo that mirrors the notification tool's candlestick view while enabling fully editable custom lines backed by live OHLCV pulled from Yahoo Finance.

## Usage

1. Start the Python backend in the `draw_line` folder (serves the UI and APIs): `python3 server.py`.
2. Open `http://localhost:8000` in your browser.
3. Enter a ticker and range, then click **Load from Yahoo Finance** to fetch real OHLCV candles (or use the synthetic generator as a fallback).
4. Choose the auto-extension behavior for new lines (forward, backward, both, or none).
5. Draw new lines, edit endpoints, delete shapes with the eraser/clear buttons. Lines are stored per ticker in `lines.json` so they survive ticker switches and page reloads in this format:

```json
[
  {
    "AAPL": [
      [
        ["2023-01-01T00:00:00.000Z", 150.0],
        ["2023-02-01T00:00:00.000Z", 160.0]
      ]
    ]
  }
]
```

The canvas padding allows drawing anywhere, even outside the visible candle range, and Plotly's edit handles let you drag individual endpoints after a line is placed.
