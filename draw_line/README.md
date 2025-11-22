# Draw Line Playground

A Plotly-powered demo that mirrors the notification tool's candlestick view while enabling fully editable custom lines.

## Usage

1. Run a simple HTTP server in the `draw_line` folder (for example: `python -m http.server 8000`).
2. Open `http://localhost:8000` in your browser.
3. Use the left-hand controls to generate synthetic candles, draw new lines, edit endpoints, or delete shapes with the eraser/clear buttons.

The canvas padding allows drawing anywhere, even outside the visible candle range, and Plotly's edit handles let you drag individual endpoints after a line is placed.
