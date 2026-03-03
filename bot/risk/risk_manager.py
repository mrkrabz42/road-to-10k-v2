"""Risk management — enforces position sizing, stop-losses, and daily loss limits.

Rules (NEVER override):
- Max 2% of portfolio risked per trade
- Max 5 open positions at any time
- Daily loss limit: 5% — kill switch halts trading if breached
- Stop-loss at 2x ATR below entry
"""

import pandas as pd
from ta.volatility import AverageTrueRange
from loguru import logger

from bot.config import (
    MAX_RISK_PER_TRADE,
    MAX_OPEN_POSITIONS,
    DAILY_LOSS_LIMIT,
    ATR_STOP_LOSS_MULTIPLIER,
)
from bot.data.market_data import get_account_info, get_positions


class RiskManager:
    """Enforces all risk management rules before any trade is placed."""

    def __init__(self):
        self._kill_switch_active = False

    @property
    def kill_switch_active(self) -> bool:
        return self._kill_switch_active

    def check_kill_switch(self) -> bool:
        """Check if daily loss limit has been breached. Returns True if trading should stop."""
        if self._kill_switch_active:
            logger.warning("KILL SWITCH ACTIVE — trading halted for the day")
            return True

        account = get_account_info()
        daily_pnl_pct = account["daily_pnl_pct"]

        if daily_pnl_pct <= -DAILY_LOSS_LIMIT:
            self._kill_switch_active = True
            logger.critical(
                f"KILL SWITCH TRIGGERED — Daily P&L: {daily_pnl_pct:.2%} exceeds limit of {-DAILY_LOSS_LIMIT:.2%}. "
                f"All trading halted."
            )
            return True

        return False

    def can_open_position(self) -> bool:
        """Check if we can open a new position (under max positions limit)."""
        positions = get_positions()
        if len(positions) >= MAX_OPEN_POSITIONS:
            logger.warning(f"Max positions reached ({MAX_OPEN_POSITIONS}). Cannot open new position.")
            return False
        return True

    def calculate_position_size(self, entry_price: float, stop_loss_price: float) -> int:
        """Calculate number of shares based on risk per trade.

        Risk per trade = MAX_RISK_PER_TRADE * portfolio_value
        Shares = risk_amount / (entry_price - stop_loss_price)
        """
        account = get_account_info()
        portfolio_value = account["portfolio_value"]
        risk_amount = portfolio_value * MAX_RISK_PER_TRADE

        risk_per_share = abs(entry_price - stop_loss_price)
        if risk_per_share <= 0:
            logger.error("Invalid stop-loss: risk per share is zero or negative")
            return 0

        shares = int(risk_amount / risk_per_share)

        # Ensure we don't exceed buying power
        total_cost = shares * entry_price
        if total_cost > account["buying_power"]:
            shares = int(account["buying_power"] / entry_price)
            logger.warning(f"Position sized down to {shares} shares due to buying power limit")

        if shares <= 0:
            logger.warning("Calculated position size is 0 — trade too small or insufficient buying power")
            return 0

        logger.info(
            f"Position size: {shares} shares @ ${entry_price:.2f} | "
            f"Risk: ${risk_amount:.2f} ({MAX_RISK_PER_TRADE:.0%}) | "
            f"Stop-loss: ${stop_loss_price:.2f}"
        )
        return shares

    def calculate_stop_loss(self, df: pd.DataFrame, entry_price: float) -> float:
        """Calculate stop-loss price at 2x ATR below entry.

        Args:
            df: DataFrame with High, Low, Close columns (recent price data)
            entry_price: The intended entry price
        """
        if len(df) < 14:
            # Not enough data for ATR — use a 3% default stop
            stop_loss = entry_price * 0.97
            logger.warning(f"Not enough data for ATR, using 3% default stop-loss: ${stop_loss:.2f}")
            return stop_loss

        atr = AverageTrueRange(df["High"], df["Low"], df["Close"], window=14)
        atr_value = atr.average_true_range().iloc[-1]

        stop_loss = entry_price - (ATR_STOP_LOSS_MULTIPLIER * atr_value)
        logger.info(f"ATR({14}): ${atr_value:.2f} | Stop-loss: ${stop_loss:.2f} ({ATR_STOP_LOSS_MULTIPLIER}x ATR below ${entry_price:.2f})")
        return round(stop_loss, 2)

    def approve_trade(self, symbol: str, entry_price: float, stop_loss_price: float) -> dict | None:
        """Run all risk checks and return approved trade details, or None if rejected.

        Returns:
            dict with keys: symbol, shares, entry_price, stop_loss_price — or None
        """
        # Check kill switch
        if self.check_kill_switch():
            return None

        # Check position limit
        if not self.can_open_position():
            return None

        # Calculate position size
        shares = self.calculate_position_size(entry_price, stop_loss_price)
        if shares == 0:
            return None

        approved = {
            "symbol": symbol,
            "shares": shares,
            "entry_price": entry_price,
            "stop_loss_price": stop_loss_price,
        }
        logger.info(f"Trade APPROVED: {symbol} x{shares} @ ${entry_price:.2f}, stop @ ${stop_loss_price:.2f}")
        return approved

    def reset_kill_switch(self):
        """Reset kill switch for a new trading day."""
        self._kill_switch_active = False
        logger.info("Kill switch reset for new trading day")
