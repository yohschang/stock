from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
import logging
from pathlib import Path
from typing import Dict, List, Literal

import pandas as pd
import yfinance as yf
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, validator
from sqlalchemy import Column, DateTime, Float, String, create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, declarative_base, sessionmaker

ExtendMode = Literal["segment_only", "extend_forward", "extend_both"]

logger = logging.getLogger("line_alert")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+psycopg2://postgres:postgres@0.0.0.0:5432/postgres",
)

engine = create_engine(DATABASE_URL, future=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class LineORM(Base):
    __tablename__ = "lines"
    id = Column(String, primary_key=True, index=True)
    symbol = Column(String, nullable=False)
    t1 = Column(DateTime, nullable=False)
    p1 = Column(Float, nullable=False)
    t2 = Column(DateTime, nullable=False)
    p2 = Column(Float, nullable=False)
    extend_mode = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


@dataclass
class Line:
    id: str
    symbol: str
    t1: datetime
    p1: float
    t2: datetime
    p2: float
    extend_mode: ExtendMode
    created_at: datetime

    @property
    def slope(self) -> float:
        delta = self.t2.timestamp() - self.t1.timestamp()
        if delta == 0:
            raise ValueError("t1 and t2 cannot be identical")
        return (self.p2 - self.p1) / delta

    def price_at(self, t: datetime) -> float:
        dt = t.timestamp() - self.t1.timestamp()
        return self.p1 + self.slope * dt

    def is_time_in_range(self, t: datetime) -> bool:
        if self.extend_mode == "segment_only":
            return self.t1 <= t <= self.t2 or self.t2 <= t <= self.t1
        if self.extend_mode == "extend_forward":
            return t >= self.t1
        return True


class PriceBar(BaseModel):
    time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: int


class LineCreate(BaseModel):
    symbol: str
    t1: datetime
    p1: float
    t2: datetime
    p2: float
    extend_mode: ExtendMode = Field(default="extend_forward")

    @validator("symbol")
    def symbol_upper(cls, v: str) -> str:
        return v.upper()


class LineResponse(BaseModel):
    id: str
    symbol: str
    t1: datetime
    p1: float
    t2: datetime
    p2: float
    slope: float
    extend_mode: ExtendMode
    created_at: datetime


class BacktestRequest(BaseModel):
    line_id: str
    start: date
    end: date
    interval: str = Field(default="1d")

    @validator("end")
    def ensure_order(cls, v: date, values: Dict[str, date]) -> date:
        start = values.get("start")
        if start and v < start:
            raise ValueError("end must be on or after start")
        return v


class CrossEvent(BaseModel):
    time: datetime
    price: float
    direction: Literal["up", "down", "touch"]


class ClickLog(BaseModel):
    time: datetime
    price: float
    mode: str
    point_index: int


class DeleteAllResponse(BaseModel):
    status: str
    count: int


class LineUpdate(BaseModel):
    t1: datetime
    p1: float
    t2: datetime
    p2: float
    extend_mode: ExtendMode


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def line_from_orm(model: LineORM) -> Line:
    return Line(
        id=model.id,
        symbol=model.symbol,
        t1=model.t1,
        p1=model.p1,
        t2=model.t2,
        p2=model.p2,
        extend_mode=model.extend_mode,  # type: ignore[arg-type]
        created_at=model.created_at,
    )


def fetch_price_data(symbol: str, start: datetime, end: datetime, interval: str) -> List[PriceBar]:
    """Fetch OHLC data from yfinance and normalize output."""
    logger.info(
        "Downloading price data: symbol=%s start=%s end=%s interval=%s",
        symbol,
        start.isoformat(),
        end.isoformat(),
        interval,
    )
    try:
        df = yf.download(symbol, start=start, end=end, interval=interval, progress=False, auto_adjust=True)
    except Exception as exc:  # pragma: no cover - network issues
        logger.warning("yfinance download failed: %s", exc)
        df = pd.DataFrame()

    if df.empty:
        logger.warning("No data from yfinance, generating synthetic sample for demo.")
        freq = "D" if interval.endswith("d") else "H"
        dates = pd.date_range(start=start, end=end, freq=freq)
        if not len(dates):
            raise HTTPException(status_code=404, detail="No price data found for given parameters")
        price = 100.0
        rows = []
        for dt in dates:
            change = 0.5 - 0.25
            price = max(1.0, price + change)
            high = price + 1.0
            low = price - 1.0
            rows.append(
                {"Date": dt, "Open": price - 0.3, "High": high, "Low": low, "Close": price, "Volume": 1_000_000}
            )
        df = pd.DataFrame(rows)

    # Flatten possible multi-index columns (yfinance returns (field, ticker) when single ticker).
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [col[0] if isinstance(col, tuple) and len(col) > 0 else str(col) for col in df.columns]

    df = df.reset_index()

    def _scalar(val):
        if isinstance(val, pd.Series):
            return val.iloc[0]
        return val

    bars: List[PriceBar] = []
    for _, row in df.iterrows():
        raw_time = _scalar(row["Date"])
        ts = raw_time.to_pydatetime() if isinstance(raw_time, pd.Timestamp) else raw_time
        bars.append(
            PriceBar(
                time=ts,
                open=float(_scalar(row["Open"])),
                high=float(_scalar(row["High"])),
                low=float(_scalar(row["Low"])),
                close=float(_scalar(row["Close"])),
                volume=int(_scalar(row["Volume"])),
            )
        )
    return bars


def find_crossings(line: Line, bars: List[PriceBar]) -> List[CrossEvent]:
    """Detect price-line crossings using bar-to-bar sign changes."""
    events: List[CrossEvent] = []
    for idx in range(len(bars) - 1):
        first = bars[idx]
        second = bars[idx + 1]

        if line.extend_mode == "segment_only" and not (
            line.is_time_in_range(first.time) or line.is_time_in_range(second.time)
        ):
            continue

        price_a, price_b = first.close, second.close
        line_a, line_b = line.price_at(first.time), line.price_at(second.time)

        d_a, d_b = price_a - line_a, price_b - line_b

        if d_a == 0 or d_b == 0:
            events.append(CrossEvent(time=second.time, price=price_b, direction="touch"))
            continue

        if d_a * d_b < 0:
            ratio = abs(d_a) / (abs(d_a) + abs(d_b))
            cross_ts = first.time.timestamp() + (second.time.timestamp() - first.time.timestamp()) * ratio
            cross_time = datetime.fromtimestamp(cross_ts)
            events.append(
                CrossEvent(
                    time=cross_time,
                    price=line.price_at(cross_time),
                    direction="up" if d_a < 0 and d_b > 0 else "down",
                )
            )
    return events


app = FastAPI(title="Line Alert Backtester", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    try:
        Base.metadata.create_all(bind=engine)
    except SQLAlchemyError as exc:
        raise RuntimeError(f"Failed to create tables: {exc}") from exc


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


def date_to_datetime(dt: date) -> datetime:
    return datetime.combine(dt, time.min)


@app.get("/price-data", response_model=List[PriceBar])
def price_data(symbol: str, start: date, end: date, interval: str = "1d") -> List[PriceBar]:
    start_dt = date_to_datetime(start)
    end_dt = date_to_datetime(end)
    bars = fetch_price_data(symbol=symbol.upper(), start=start_dt, end=end_dt, interval=interval)
    logger.info("Price data returned %d bars for %s", len(bars), symbol)
    return bars


@app.post("/lines", response_model=LineResponse)
def create_line(payload: LineCreate, db: Session = Depends(get_db)) -> LineResponse:
    new_id = str(uuid.uuid4())
    created_at = datetime.utcnow()
    line = Line(
        id=new_id,
        symbol=payload.symbol.upper(),
        t1=payload.t1,
        p1=payload.p1,
        t2=payload.t2,
        p2=payload.p2,
        extend_mode=payload.extend_mode,
        created_at=created_at,
    )
    _ = line.slope
    record = LineORM(
        id=line.id,
        symbol=line.symbol,
        t1=line.t1,
        p1=line.p1,
        t2=line.t2,
        p2=line.p2,
        extend_mode=line.extend_mode,
        created_at=line.created_at,
    )
    db.add(record)
    db.commit()
    return LineResponse(
        id=line.id,
        symbol=line.symbol,
        t1=line.t1,
        p1=line.p1,
        t2=line.t2,
        p2=line.p2,
        slope=line.slope,
        extend_mode=line.extend_mode,
        created_at=line.created_at,
    )


@app.get("/lines/{line_id}", response_model=LineResponse)
def get_line(line_id: str, db: Session = Depends(get_db)) -> LineResponse:
    record = db.get(LineORM, line_id)
    if not record:
        raise HTTPException(status_code=404, detail="Line not found")
    line = line_from_orm(record)
    return LineResponse(
        id=line.id,
        symbol=line.symbol,
        t1=line.t1,
        p1=line.p1,
        t2=line.t2,
        p2=line.p2,
        slope=line.slope,
        extend_mode=line.extend_mode,
        created_at=line.created_at,
    )


@app.put("/lines/{line_id}", response_model=LineResponse)
def update_line(line_id: str, payload: LineUpdate, db: Session = Depends(get_db)) -> LineResponse:
    record = db.get(LineORM, line_id)
    if not record:
        raise HTTPException(status_code=404, detail="Line not found")
    record.t1 = payload.t1
    record.p1 = payload.p1
    record.t2 = payload.t2
    record.p2 = payload.p2
    record.extend_mode = payload.extend_mode
    db.add(record)
    db.commit()
    db.refresh(record)
    line = line_from_orm(record)
    return LineResponse(
        id=line.id,
        symbol=line.symbol,
        t1=line.t1,
        p1=line.p1,
        t2=line.t2,
        p2=line.p2,
        slope=line.slope,
        extend_mode=line.extend_mode,
        created_at=line.created_at,
    )


@app.get("/lines", response_model=List[LineResponse])
def list_lines(db: Session = Depends(get_db)) -> List[LineResponse]:
    records = db.query(LineORM).all()
    responses = []
    for record in records:
        line = line_from_orm(record)
        responses.append(
            LineResponse(
                id=line.id,
                symbol=line.symbol,
                t1=line.t1,
                p1=line.p1,
                t2=line.t2,
                p2=line.p2,
                slope=line.slope,
                extend_mode=line.extend_mode,
                created_at=line.created_at,
            )
        )
    return responses


@app.post("/backtest-crossings", response_model=List[CrossEvent])
def backtest_crossings(payload: BacktestRequest, db: Session = Depends(get_db)) -> List[CrossEvent]:
    record = db.get(LineORM, payload.line_id)
    if not record:
        raise HTTPException(status_code=404, detail="Line not found")
    line = line_from_orm(record)
    bars = fetch_price_data(
        symbol=line.symbol,
        start=date_to_datetime(payload.start),
        end=date_to_datetime(payload.end),
        interval=payload.interval,
    )
    return find_crossings(line, bars)


@app.delete("/lines/{line_id}")
def delete_line(line_id: str, db: Session = Depends(get_db)) -> Dict[str, str]:
    record = db.get(LineORM, line_id)
    if not record:
        raise HTTPException(status_code=404, detail="Line not found")
    db.delete(record)
    db.commit()
    logger.info("Deleted line %s", line_id)
    return {"status": "deleted", "id": line_id}


@app.delete("/lines", response_model=DeleteAllResponse)
def delete_all_lines(db: Session = Depends(get_db)) -> DeleteAllResponse:
    deleted = db.query(LineORM).delete()
    db.commit()
    logger.info("Deleted %s lines", deleted)
    return DeleteAllResponse(status="deleted_all", count=deleted)


@app.post("/click-log")
def log_click(payload: ClickLog) -> Dict[str, str]:
    logger.info("Click: mode=%s idx=%s time=%s price=%s", payload.mode, payload.point_index, payload.time, payload.price)
    return {"status": "ok"}


# Serve built frontend assets for convenience.
ROOT_DIR = Path(__file__).resolve().parent.parent
frontend_dist = ROOT_DIR / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dist), html=True), name="frontend")
