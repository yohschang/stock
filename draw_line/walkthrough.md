# Walkthrough: Enhanced Draw Line Tool

I have updated the tool to include a Python backend for reliable data fetching and added new frontend features for line management.

## Changes

### 1. Python Backend (`server.py`)
- **Fixes Fetch Error**: Uses `yfinance` Python library instead of direct browser fetch to avoid CORS and format issues.
- **Auto Adjust**: Enables `auto_adjust=True` for accurate historical prices.
- **API Endpoint**: Serves data at `/api/data`.

### 2. Line Selection and Deletion
- **Select**: Click on any drawn line to select it. The line will turn white and dotted.
- **Delete**: A "Delete Selected" button appears in the toolbar when a line is selected.
- **Visual Feedback**: Selected lines are clearly highlighted.

### 3. Interval Persistence
- **View Range**: When changing intervals (e.g., 1d to 1h) for the same ticker, the chart now preserves your current zoom/view range instead of resetting it.
- **Line Interpolation**: Lines are stored with absolute timestamps, ensuring they remain correctly positioned across different time intervals.

## How to Run

1.  **Stop any running servers** on port 8000.
2.  **Run the new server**:
    ```bash
    python3 server.py
    ```
3.  **Open the tool**:
    Go to [http://localhost:8000](http://localhost:8000) in your browser.

## Usage

1.  **Load Data**: Enter a ticker (e.g., AAPL) and click "Load".
2.  **Draw**: Click "Draw line" and drag on the chart.
3.  **Select**: Click directly on a line to select it.
4.  **Delete**: Click the "Delete Selected" button to remove the selected line.
5.  **Change Interval**: Change the dropdown from "1d" to "1h". The chart will update, lines will stay, and your view range will be preserved.
