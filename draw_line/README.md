# Draw Line Playground

A Plotly-powered demo that mirrors the notification tool's candlestick view while enabling fully editable custom lines backed by live OHLCV pulled from Yahoo Finance.

## Usage

1. Run a simple HTTP server in the `draw_line` folder (for example: `python -m http.server 8000`).
2. Open `http://localhost:8000` in your browser.
3. Enter a ticker and range, then click **Load from Yahoo Finance** to fetch real OHLCV candles (or use the synthetic generator as a fallback).
4. Choose the auto-extension behavior for new lines (forward, backward, both, or none).
5. Draw new lines, edit endpoints, delete shapes with the eraser/clear buttons, and reload the same ticker to see your saved lines restored.

The canvas padding allows drawing anywhere, even outside the visible candle range, and Plotly's edit handles let you drag individual endpoints after a line is placed. Lines and their extension settings are stored per ticker in `localStorage`.
