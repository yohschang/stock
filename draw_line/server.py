import http.server
import socketserver
import urllib.parse
import json
import yfinance as yf
import pandas as pd
import os

PORT = 8888

class TradingToolHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        if parsed_path.path == '/api/data':
            self.handle_data_request(parsed_path.query)
        else:
            super().do_GET()

    def handle_data_request(self, query_string):
        params = urllib.parse.parse_qs(query_string)
        ticker = params.get('ticker', [''])[0]
        interval = params.get('interval', ['1d'])[0]
        period = params.get('range', ['1mo'])[0]

        if not ticker:
            self.send_error(400, "Missing ticker parameter")
            return

        try:
            # Map 'range' from frontend to 'period' for yfinance
            # Frontend uses: 1mo, 3mo, 6mo, 1y. yfinance supports these.
            
            # Fetch data
            print(f"Fetching data for {ticker}, interval={interval}, period={period}")
            df = yf.download(ticker, interval=interval, period=period, auto_adjust=True, progress=False)
            
            if df.empty:
                self.send_error(404, "No data found for ticker")
                return

            # Reset index to get Date/Datetime as a column
            df = df.reset_index()
            
            # Handle multi-level columns if present (yfinance update)
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)

            # Rename columns to lowercase for consistency with frontend
            df.columns = [c.lower() for c in df.columns]
            
            # Prepare response
            # Ensure date is datetime
            date_col = 'date' if 'date' in df.columns else 'datetime'
            if date_col not in df.columns:
                 # Fallback if something weird happens
                 self.send_error(500, "Could not find date column")
                 return

            timestamps = df[date_col].astype(int) // 10**6 # ms
            
            # Filter out NaNs
            result = {
                'dates': timestamps.tolist(),
                'open': df['open'].fillna(0).tolist(),
                'high': df['high'].fillna(0).tolist(),
                'low': df['low'].fillna(0).tolist(),
                'close': df['close'].fillna(0).tolist(),
            }
            
            response_body = json.dumps(result).encode('utf-8')
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(response_body)

        except Exception as e:
            print(f"Error fetching data: {e}")
            self.send_error(500, str(e))

print(f"Serving at http://localhost:{PORT}")
with socketserver.TCPServer(("", PORT), TradingToolHandler) as httpd:
    httpd.serve_forever()
