import yfinance as yf
import pandas as pd

print(f"yfinance version: {yf.__version__}")

def test_download(ticker, interval, period):
    print(f"Testing {ticker} {interval} {period}...")
    try:
        df = yf.download(ticker, interval=interval, period=period, auto_adjust=True, progress=False)
        if df.empty:
            print("  -> EMPTY")
        else:
            print(f"  -> OK, shape: {df.shape}")
            # Check columns
            if isinstance(df.columns, pd.MultiIndex):
                print("  -> MultiIndex columns detected")
    except Exception as e:
        print(f"  -> ERROR: {e}")

test_download("NVDA", "1d", "6mo")
test_download("nvda", "1d", "6mo")
test_download("NVDA", "1wk", "6mo")
test_download("NVDA", "1mo", "6mo")
test_download("NVDA", "1d", "3mo")

