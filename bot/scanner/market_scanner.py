"""Scans a watchlist for trade opportunities using configured strategies."""

from loguru import logger

from bot.config import WATCHLIST
from bot.data.market_data import get_historical_bars
from bot.strategies.base_strategy import Signal
from bot.strategies.sma_crossover import SMACrossover


def scan_watchlist(symbols: list[str] | None = None, timeframe: str = "day", days_back: int = 100) -> list[dict]:
    """Scan symbols and return those with BUY or SELL signals.

    Returns:
        List of dicts with keys: symbol, signal, strategy
    """
    if symbols is None:
        symbols = WATCHLIST

    results = []

    for symbol in symbols:
        try:
            df = get_historical_bars(symbol, timeframe=timeframe, days_back=days_back)
            if df.empty:
                logger.warning(f"No data for {symbol}, skipping")
                continue

            strategy = SMACrossover(symbol, timeframe)
            signal = strategy.evaluate(df)

            if signal != Signal.HOLD:
                results.append({
                    "symbol": symbol,
                    "signal": signal.value,
                    "strategy": strategy.name,
                })

        except Exception as e:
            logger.error(f"Error scanning {symbol}: {e}")
            continue

    logger.info(f"Scanner found {len(results)} signals from {len(symbols)} symbols")
    return results
