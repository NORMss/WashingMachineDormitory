#!/usr/bin/env python3
"""
Telegram bot for dormitory washing machine status.
Runs on a separate server (outside Russia) and communicates
with the laundry status API to sync machine state with Telegram chat.
"""

import asyncio
import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import httpx
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ─── Config ────────────────────────────────────────────────────────────────────

BOT_TOKEN: str = os.environ["BOT_TOKEN"]
CHAT_ID: int = int(os.environ["CHAT_ID"])
LAUNDRY_API_URL: str = os.environ["LAUNDRY_API_URL"].rstrip("/")
BOT_PIN: str = os.environ["BOT_PIN"]
DATA_FILE = Path(os.getenv("DATA_FILE", "/data/bot_data.json"))
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "30"))
# UTC offset for displaying times (Moscow = 3)
TZ_OFFSET = int(os.getenv("TIMEZONE_OFFSET", "3"))

LOCAL_TZ = timezone(timedelta(hours=TZ_OFFSET))

# Room pattern mirrors the server validation rule
ROOM_RE = re.compile(r"^(?=.*\d)[0-9A-Za-zА-Яа-яёЁ\-_/]{1,16}$")

# occupiedUntil value set by the bot itself via chat message.
# The poller skips the "occupied" notification for this session
# because the user already got "✅ Записано!" as a reply.
_bot_set_occupied_until: Optional[str] = None

# Matches "До HH:MM", "до 19;00", "22.13", "00:10:00" — full message only.
# Separators: colon, dot, semicolon. Optional "до" prefix, optional seconds.
TIME_RE = re.compile(
    r"^\s*(?:до\s*)?(\d{1,2})[:.;](\d{2})(?:[:.;]\d{2})?[.!]?\s*$",
    re.IGNORECASE,
)

# ─── Persistence ───────────────────────────────────────────────────────────────


def _load_data() -> dict:
    if DATA_FILE.exists():
        try:
            return json.loads(DATA_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"rooms": {}, "last_occupied": None, "last_occupied_until": None, "last_occupied_room": None}


def _save_data(data: dict) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# ─── Time helpers ──────────────────────────────────────────────────────────────


def parse_time(text: str) -> Optional[tuple[int, int]]:
    """Return (hour, minute) from a 'до HH:MM' style message, or None."""
    m = TIME_RE.match(text.strip())
    if not m:
        return None
    hour, minute = int(m.group(1)), int(m.group(2))
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return hour, minute


def minutes_until(hour: int, minute: int) -> int:
    """Minutes from now (local tz) until the given clock time (next occurrence)."""
    now = datetime.now(LOCAL_TZ)
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return max(1, int((target - now).total_seconds() / 60))


def fmt_iso(iso: Optional[str]) -> str:
    """Format ISO UTC datetime as HH:MM in local timezone."""
    if not iso:
        return "?"
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(LOCAL_TZ)
        return dt.strftime("%H:%M")
    except Exception:
        return "?"


def fmt_status(status: dict) -> str:
    if not status.get("occupied"):
        return "✅ Машинка свободна"
    room = status.get("occupiedRoom") or status.get("occupiedBy") or "?"
    until = fmt_iso(status.get("occupiedUntil"))
    return f"🧺 Машинка занята\n🏠 Комната: {room}\n⏳ До: {until}"


# ─── API calls ─────────────────────────────────────────────────────────────────


async def api_get_status() -> Optional[dict]:
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"{LAUNDRY_API_URL}/api/status")
            r.raise_for_status()
            return r.json()
    except Exception as e:
        logger.warning("api_get_status error: %s", e)
        return None


async def api_get_history(limit: int = 5) -> Optional[list]:
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"{LAUNDRY_API_URL}/api/history", params={"limit": limit})
            r.raise_for_status()
            return r.json().get("items", [])
    except Exception as e:
        logger.warning("api_get_history error: %s", e)
        return None


async def api_occupy(minutes: int, room: str) -> tuple[bool, str, Optional[str]]:
    """Returns (success, error_message, occupiedUntil_iso_or_None)."""
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(
                f"{LAUNDRY_API_URL}/api/status/occupy",
                json={"minutes": minutes, "occupiedRoom": room, "pin": BOT_PIN},
            )
            if r.status_code == 200:
                return True, "", r.json().get("occupiedUntil")
            data = r.json()
            if r.status_code == 409:
                occupied_room = data.get("occupiedRoom") or "?"
                occupied_until = fmt_iso(data.get("occupiedUntil"))
                return False, f"Машинка уже занята (комната {occupied_room}, до {occupied_until})", None
            return False, data.get("error", "Ошибка сервера"), None
    except Exception as e:
        logger.warning("api_occupy error: %s", e)
        return False, "Нет связи с сервером", None


async def api_release() -> tuple[bool, str]:
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(
                f"{LAUNDRY_API_URL}/api/status/release",
                json={"pin": BOT_PIN},
            )
            if r.status_code == 200:
                return True, ""
            return False, r.json().get("error", "Ошибка сервера")
    except Exception as e:
        logger.warning("api_release error: %s", e)
        return False, "Нет связи с сервером"


# ─── Command handlers ──────────────────────────────────────────────────────────


async def cmd_help(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "🧺 Бот стиральной машины\n\n"
        "Команды:\n"
        "  /status — текущий статус\n"
        "  /history — последние 5 стирок\n"
        "  /setroom <номер> — сохранить номер комнаты\n"
        "  /stop — освободить машинку досрочно\n\n"
        "Чтобы занять машинку, напиши время окончания в чат:\n"
        "  До 21:00\n"
        "  до 19;00\n"
        "  22.13\n\n"
        "Перед первым использованием укажи свою комнату:\n"
        "  /setroom 301",
        disable_notification=True,
    )


async def cmd_status(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    status = await api_get_status()
    if status is None:
        await update.message.reply_text("❌ Нет связи с сервером", disable_notification=True)
        return
    await update.message.reply_text(fmt_status(status), disable_notification=True)


async def cmd_history(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    items = await api_get_history(5)
    if items is None:
        await update.message.reply_text("❌ Нет связи с сервером", disable_notification=True)
        return
    if not items:
        await update.message.reply_text("История пуста", disable_notification=True)
        return

    lines = ["📋 Последние стирки:"]
    for item in items:
        room = item.get("occupiedRoom") or "?"
        started = fmt_iso(item.get("startedAt"))
        finished = fmt_iso(item.get("finishedAt"))
        duration = item.get("durationMinutes", 0)
        lines.append(f"🏠 {room} — {started}–{finished} ({duration} мин)")
    await update.message.reply_text("\n".join(lines), disable_notification=True)


async def cmd_setroom(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not ctx.args:
        await update.message.reply_text(
            "Укажи номер комнаты:\n/setroom 301\n/setroom 2-15",
            disable_notification=True,
        )
        return

    room = ctx.args[0].strip()
    if not ROOM_RE.match(room):
        await update.message.reply_text(
            "❌ Неверный формат. Используй 1–16 символов, минимум 1 цифра.\n"
            "Примеры: 301, 2-15, комн301",
            disable_notification=True,
        )
        return

    data = _load_data()
    data["rooms"][str(update.effective_user.id)] = room
    _save_data(data)
    await update.message.reply_text(f"✅ Комната сохранена: {room}", disable_notification=True)


async def cmd_stop(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_chat.id != CHAT_ID:
        return
    ok, err = await api_release()
    if ok:
        await update.message.reply_text("✅ Машинка освобождена", disable_notification=True)
    else:
        await update.message.reply_text(f"❌ {err}", disable_notification=True)


# ─── Message handler ───────────────────────────────────────────────────────────


async def handle_message(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Detect 'до HH:MM' style messages and occupy the machine."""
    global _bot_set_occupied_until

    if update.effective_chat.id != CHAT_ID:
        return
    if not update.message or not update.message.text:
        return

    parsed = parse_time(update.message.text)
    if parsed is None:
        return  # Not a time announcement — ignore

    hour, minute = parsed

    data = _load_data()
    room = data["rooms"].get(str(update.effective_user.id))

    if not room:
        await update.message.reply_text(
            "Укажи номер своей комнаты, чтобы занять машинку:\n/setroom 301",
            reply_to_message_id=update.message.message_id,
            disable_notification=True,
        )
        return

    mins = minutes_until(hour, minute)
    ok, err, occupied_until = await api_occupy(mins, room)

    if ok:
        # Tell the poller to skip the notification for this session —
        # the user already sees "✅ Записано!" as a reply.
        _bot_set_occupied_until = occupied_until

        now = datetime.now(LOCAL_TZ)
        target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        await update.message.reply_text(
            f"✅ Записано! Машинка занята до {target.strftime('%H:%M')} ({mins} мин)\n🏠 Комната: {room}",
            reply_to_message_id=update.message.message_id,
            disable_notification=True,
        )
    else:
        await update.message.reply_text(
            f"❌ {err}",
            reply_to_message_id=update.message.message_id,
            disable_notification=True,
        )


# ─── Status polling ────────────────────────────────────────────────────────────


async def poll_status(app: Application) -> None:
    """Background loop: poll API every POLL_INTERVAL seconds, notify on changes."""
    global _bot_set_occupied_until

    # Snapshot initial state silently (avoid notification on bot startup)
    initial = await api_get_status()
    last = {
        "occupied": initial.get("occupied", False) if initial else False,
        "occupiedUntil": (initial or {}).get("occupiedUntil"),
        "occupiedRoom": (initial or {}).get("occupiedRoom"),
    }
    logger.info("Polling started. Initial state: occupied=%s", last["occupied"])

    while True:
        await asyncio.sleep(POLL_INTERVAL)
        status = await api_get_status()
        if status is None:
            continue

        current = {
            "occupied": status.get("occupied", False),
            "occupiedUntil": status.get("occupiedUntil"),
            "occupiedRoom": status.get("occupiedRoom"),
        }

        # Notify when occupied→free, free→occupied, or new session started
        state_changed = current["occupied"] != last["occupied"]
        session_replaced = (
            current["occupied"]
            and last["occupied"]
            and current["occupiedUntil"] != last["occupiedUntil"]
        )

        if state_changed or session_replaced:
            if current["occupied"]:
                # Skip notification if the bot itself just occupied the machine
                # via a chat message — the user already got "✅ Записано!" reply.
                if _bot_set_occupied_until and current["occupiedUntil"] == _bot_set_occupied_until:
                    logger.info("Suppressed duplicate 'occupied' notification (set by bot)")
                    _bot_set_occupied_until = None
                    last = current
                    continue

                msg = fmt_status(status)
            else:
                _bot_set_occupied_until = None  # clear on release regardless
                prev = last.get("occupiedRoom") or "?"
                msg = f"✅ Машинка свободна\n🏠 Была занята: {prev}"

            try:
                await app.bot.send_message(
                    chat_id=CHAT_ID,
                    text=msg,
                    disable_notification=True,
                )
                logger.info("Sent notification: occupied=%s", current["occupied"])
            except Exception as e:
                logger.error("send_message error: %s", e)

        last = current


# ─── Entry point ───────────────────────────────────────────────────────────────


async def _post_init(app: Application) -> None:
    asyncio.create_task(poll_status(app))


def main() -> None:
    app = (
        Application.builder()
        .token(BOT_TOKEN)
        .post_init(_post_init)
        .build()
    )

    app.add_handler(CommandHandler(["start", "help"], cmd_help))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("history", cmd_history))
    app.add_handler(CommandHandler("setroom", cmd_setroom))
    app.add_handler(CommandHandler("stop", cmd_stop))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info("Bot starting (poll_interval=%ds, tz=UTC+%d)…", POLL_INTERVAL, TZ_OFFSET)
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
