const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, "data");
const STATUS_FILE = path.join(DATA_DIR, "status.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const CONFIG_FILE = path.join(__dirname, "config.json");
const MAX_OCCUPY_MINUTES = 24 * 60;
const MAX_HISTORY_ITEMS = 200;
const DEFAULT_STATUS_PIN = "1234";
const ROOM_PATTERN = /^(?=.*\d)[0-9A-Za-zА-Яа-я\-_/]{1,16}$/u;
const TELEGRAM_BOT_TOKEN =
  typeof process.env.TELEGRAM_BOT_TOKEN === "string" ? process.env.TELEGRAM_BOT_TOKEN.trim() : "";
const TELEGRAM_CHAT_ID = typeof process.env.TELEGRAM_CHAT_ID === "string" ? process.env.TELEGRAM_CHAT_ID.trim() : "";
const TELEGRAM_API_BASE_URL =
  typeof process.env.TELEGRAM_API_BASE_URL === "string" && process.env.TELEGRAM_API_BASE_URL.trim()
    ? process.env.TELEGRAM_API_BASE_URL.trim().replace(/\/+$/, "")
    : "https://api.telegram.org";
const TELEGRAM_ENABLED = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

function createDefaultStatus() {
  return {
    occupied: false,
    occupiedUntil: null,
    occupiedFrom: null,
    occupiedRoom: null,
    occupiedBy: null,
    updatedAt: new Date().toISOString(),
  };
}

function createDefaultHistory() {
  return [];
}

function createDefaultConfig() {
  return {
    statusPin: DEFAULT_STATUS_PIN,
  };
}

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(STATUS_FILE);
  } catch {
    await fs.writeFile(STATUS_FILE, JSON.stringify(createDefaultStatus(), null, 2));
  }

  try {
    await fs.access(HISTORY_FILE);
  } catch {
    await fs.writeFile(HISTORY_FILE, JSON.stringify(createDefaultHistory(), null, 2));
  }

  const hasEnvPin = typeof process.env.STATUS_PIN === "string" && process.env.STATUS_PIN.trim().length >= 4;
  if (!hasEnvPin) {
    try {
      await fs.access(CONFIG_FILE);
    } catch {
      await fs.writeFile(CONFIG_FILE, JSON.stringify(createDefaultConfig(), null, 2));
    }
  }
}

function sanitizeConfig(rawConfig) {
  const envPin = typeof process.env.STATUS_PIN === "string" ? process.env.STATUS_PIN.trim() : "";
  const filePin = typeof rawConfig?.statusPin === "string" ? rawConfig.statusPin.trim() : "";
  const pinCandidates = [envPin, filePin, DEFAULT_STATUS_PIN];
  const pin = pinCandidates.find((value) => value.length >= 4 && value.length <= 32) || DEFAULT_STATUS_PIN;

  return {
    statusPin: pin,
  };
}

function normalizeRoom(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!normalized || !ROOM_PATTERN.test(normalized)) {
    return null;
  }

  return normalized;
}

function sanitizeStatus(rawStatus) {
  const fallback = createDefaultStatus();
  const occupied = Boolean(rawStatus?.occupied);
  const updatedAt =
    typeof rawStatus?.updatedAt === "string" && !Number.isNaN(Date.parse(rawStatus.updatedAt))
      ? rawStatus.updatedAt
      : fallback.updatedAt;
  const occupiedUntilValue =
    typeof rawStatus?.occupiedUntil === "string" &&
    !Number.isNaN(Date.parse(rawStatus.occupiedUntil))
      ? rawStatus.occupiedUntil
      : null;
  const occupiedFromValue =
    typeof rawStatus?.occupiedFrom === "string" && !Number.isNaN(Date.parse(rawStatus.occupiedFrom))
      ? rawStatus.occupiedFrom
      : updatedAt;
  const occupiedRoomValue = normalizeRoom(rawStatus?.occupiedRoom || rawStatus?.occupiedBy);

  const hasValidOccupiedState = occupied && Boolean(occupiedUntilValue) && Boolean(occupiedRoomValue);

  return {
    occupied: hasValidOccupiedState,
    occupiedUntil: hasValidOccupiedState ? occupiedUntilValue : null,
    occupiedFrom: hasValidOccupiedState ? occupiedFromValue : null,
    occupiedRoom: hasValidOccupiedState ? occupiedRoomValue : null,
    occupiedBy: hasValidOccupiedState ? occupiedRoomValue : null,
    updatedAt,
  };
}

function sanitizeHistoryEntry(rawEntry) {
  const startedAt =
    typeof rawEntry?.startedAt === "string" && !Number.isNaN(Date.parse(rawEntry.startedAt))
      ? rawEntry.startedAt
      : null;
  const finishedAt =
    typeof rawEntry?.finishedAt === "string" && !Number.isNaN(Date.parse(rawEntry.finishedAt))
      ? rawEntry.finishedAt
      : null;
  const occupiedRoom = normalizeRoom(rawEntry?.occupiedRoom || rawEntry?.occupiedBy);
  const plannedUntil =
    typeof rawEntry?.plannedUntil === "string" && !Number.isNaN(Date.parse(rawEntry.plannedUntil))
      ? rawEntry.plannedUntil
      : null;
  const endReason = ["manual", "auto", "replaced"].includes(rawEntry?.endReason)
    ? rawEntry.endReason
    : "manual";
  const durationMinutes = Number(rawEntry?.durationMinutes);

  if (!startedAt || !finishedAt || !occupiedRoom) {
    return null;
  }

  return {
    id: typeof rawEntry?.id === "string" && rawEntry.id.trim() ? rawEntry.id.trim() : randomUUID(),
    occupiedRoom,
    occupiedBy: occupiedRoom,
    startedAt,
    plannedUntil,
    finishedAt,
    durationMinutes: Number.isInteger(durationMinutes) && durationMinutes > 0 ? durationMinutes : 1,
    endReason,
  };
}

function sanitizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) {
    return [];
  }

  return rawHistory
    .map((entry) => sanitizeHistoryEntry(entry))
    .filter((entry) => Boolean(entry))
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))
    .slice(0, MAX_HISTORY_ITEMS);
}

function formatTelegramDate(isoDate) {
  if (!isoDate || Number.isNaN(Date.parse(isoDate))) {
    return "—";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoDate));
}

function buildTelegramMessage(eventType, payload) {
  if (eventType === "occupied") {
    return [
      "🧺 Машинка занята",
      `🏠 Комната: ${payload.occupiedRoom || payload.occupiedBy || "—"}`,
      `⏳ До: ${formatTelegramDate(payload.occupiedUntil)}`,
      `🕒 Обновлено: ${formatTelegramDate(payload.updatedAt)}`,
    ].join("\n");
  }

  if (eventType === "released") {
    return [
      "✅ Машинка свободна",
      payload.previousOccupiedRoom ? `🏠 Была занята: ${payload.previousOccupiedRoom}` : null,
      payload.reasonText ? `ℹ️ Причина: ${payload.reasonText}` : null,
      `🕒 Время: ${formatTelegramDate(payload.updatedAt)}`,
    ]
      .filter((line) => Boolean(line))
      .join("\n");
  }

  return null;
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_ENABLED || !text) {
    return;
  }

  const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API ${response.status}: ${body.slice(0, 300)}`);
  }
}

async function notifyTelegramStatus(eventType, payload) {
  if (!TELEGRAM_ENABLED) {
    return;
  }

  const message = buildTelegramMessage(eventType, payload);
  if (!message) {
    return;
  }

  try {
    await sendTelegramMessage(message);
  } catch (error) {
    process.stderr.write(`Telegram notify error: ${error?.message || String(error)}\n`);
  }
}

async function readStatus() {
  await ensureStorage();
  const rawFile = await fs.readFile(STATUS_FILE, "utf-8");
  const parsed = JSON.parse(rawFile);
  return sanitizeStatus(parsed);
}

async function readConfig() {
  const envPin = typeof process.env.STATUS_PIN === "string" ? process.env.STATUS_PIN.trim() : "";
  if (envPin.length >= 4 && envPin.length <= 32) {
    return sanitizeConfig({ statusPin: envPin });
  }

  await ensureStorage();

  try {
    const rawFile = await fs.readFile(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(rawFile);
    return sanitizeConfig(parsed);
  } catch {
    return sanitizeConfig({});
  }
}

async function readHistory() {
  await ensureStorage();
  const rawFile = await fs.readFile(HISTORY_FILE, "utf-8");
  const parsed = JSON.parse(rawFile);
  return sanitizeHistory(parsed);
}

async function writeStatus(status) {
  await fs.writeFile(STATUS_FILE, JSON.stringify(status, null, 2));
}

async function writeHistory(history) {
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function buildHistoryEntry(status, finishedAt, endReason) {
  const occupiedRoom = normalizeRoom(status.occupiedRoom || status.occupiedBy);

  if (!status.occupied || !occupiedRoom || !status.occupiedUntil) {
    return null;
  }

  const startedAt = status.occupiedFrom || status.updatedAt || finishedAt;
  const startedAtMs = Date.parse(startedAt);
  const finishedAtMs = Date.parse(finishedAt);
  const isValidRange = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs) && finishedAtMs >= startedAtMs;
  const durationMinutes = isValidRange ? Math.max(1, Math.round((finishedAtMs - startedAtMs) / 60000)) : 1;

  return {
    id: randomUUID(),
    occupiedRoom,
    occupiedBy: occupiedRoom,
    startedAt,
    plannedUntil: status.occupiedUntil,
    finishedAt,
    durationMinutes,
    endReason,
  };
}

async function appendHistoryFromStatus(status, finishedAt, endReason) {
  const entry = buildHistoryEntry(status, finishedAt, endReason);
  if (!entry) {
    return;
  }

  const history = await readHistory();
  history.unshift(entry);

  if (history.length > MAX_HISTORY_ITEMS) {
    history.length = MAX_HISTORY_ITEMS;
  }

  await writeHistory(history);
}

function isExpired(status) {
  if (!status.occupied || !status.occupiedUntil) {
    return false;
  }

  return Date.parse(status.occupiedUntil) <= Date.now();
}

async function getRoomSuggestions(limit = 24) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 24;
  const roomsMap = new Map();

  const currentStatus = await readStatus();
  const currentRoom = normalizeRoom(currentStatus.occupiedRoom || currentStatus.occupiedBy);
  if (currentRoom) {
    roomsMap.set(currentRoom, { room: currentRoom, lastUsedAt: currentStatus.updatedAt });
  }

  const history = await readHistory();
  history.forEach((entry) => {
    const room = normalizeRoom(entry.occupiedRoom || entry.occupiedBy);
    if (!room) {
      return;
    }

    const known = roomsMap.get(room);
    const entryTime = typeof entry.finishedAt === "string" ? entry.finishedAt : entry.startedAt;

    if (!known || Date.parse(entryTime) > Date.parse(known.lastUsedAt)) {
      roomsMap.set(room, { room, lastUsedAt: entryTime });
    }
  });

  return Array.from(roomsMap.values())
    .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))
    .slice(0, safeLimit)
    .map((item) => item.room);
}

async function getCurrentStatus() {
  const status = await readStatus();

  if (!isExpired(status)) {
    return status;
  }

  const releasedStatus = {
    ...status,
    occupied: false,
    occupiedUntil: null,
    occupiedFrom: null,
    occupiedRoom: null,
    occupiedBy: null,
    updatedAt: new Date().toISOString(),
  };

  await appendHistoryFromStatus(status, status.occupiedUntil, "auto");

  await writeStatus(releasedStatus);
  void notifyTelegramStatus("released", {
    previousOccupiedRoom: status.occupiedRoom || status.occupiedBy,
    reasonText: "таймер завершился",
    updatedAt: releasedStatus.updatedAt,
  });

  return releasedStatus;
}

async function verifyPinOrReject(req, res) {
  try {
    const pin = typeof req.body?.pin === "string" ? req.body.pin.trim() : "";

    if (!pin) {
      res.status(400).json({ error: "Введите PIN-код." });
      return false;
    }

    const config = await readConfig();
    if (pin !== config.statusPin) {
      res.status(401).json({ error: "Неверный PIN-код." });
      return false;
    }

    return true;
  } catch (error) {
    res.status(500).json({ error: "Не удалось проверить PIN-код." });
    return false;
  }
}

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", async (req, res) => {
  try {
    const status = await getCurrentStatus();
    res.json({
      ...status,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: "Не удалось получить статус." });
  }
});

app.get("/api/history", async (req, res) => {
  const limit = Number(req.query?.limit);
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_HISTORY_ITEMS) : 20;

  try {
    const history = await readHistory();
    res.json({
      items: history.slice(0, safeLimit),
      total: history.length,
    });
  } catch (error) {
    res.status(500).json({ error: "Не удалось получить историю." });
  }
});

app.get("/api/rooms", async (req, res) => {
  const limit = Number(req.query?.limit);

  try {
    const items = await getRoomSuggestions(limit);
    return res.json({
      items,
      total: items.length,
    });
  } catch (error) {
    return res.status(500).json({ error: "Не удалось получить список комнат." });
  }
});

app.post("/api/status/occupy", async (req, res) => {
  const minutes = Number(req.body?.minutes);
  const occupiedRoom = normalizeRoom(req.body?.occupiedRoom || req.body?.occupiedBy);

  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_OCCUPY_MINUTES) {
    return res.status(400).json({
      error: `Укажите целое число минут от 1 до ${MAX_OCCUPY_MINUTES}.`,
    });
  }

  if (!occupiedRoom) {
    return res.status(400).json({
      error: "Укажите корректный номер комнаты (до 16 символов, должна быть хотя бы 1 цифра).",
    });
  }

  try {
    if (!(await verifyPinOrReject(req, res))) {
      return;
    }

    const current = await getCurrentStatus();
    if (current.occupied) {
      return res.status(409).json({
        error: "Машинка уже занята. Дождитесь завершения или освободите ее вручную.",
        occupiedRoom: current.occupiedRoom || current.occupiedBy,
        occupiedUntil: current.occupiedUntil,
      });
    }

    const occupiedFrom = new Date().toISOString();
    const occupiedUntil = new Date(Date.parse(occupiedFrom) + minutes * 60 * 1000).toISOString();

    const next = {
      ...current,
      occupied: true,
      occupiedUntil,
      occupiedFrom,
      occupiedRoom,
      occupiedBy: occupiedRoom,
      updatedAt: new Date().toISOString(),
    };

    await writeStatus(next);
    void notifyTelegramStatus("occupied", next);

    return res.json(next);
  } catch (error) {
    return res.status(500).json({ error: "Не удалось обновить статус." });
  }
});

app.post("/api/status/release", async (req, res) => {
  try {
    if (!(await verifyPinOrReject(req, res))) {
      return;
    }

    const current = await getCurrentStatus();
    const finishedAt = new Date().toISOString();

    await appendHistoryFromStatus(current, finishedAt, "manual");

    const next = {
      ...current,
      occupied: false,
      occupiedUntil: null,
      occupiedFrom: null,
      occupiedRoom: null,
      occupiedBy: null,
      updatedAt: new Date().toISOString(),
    };

    await writeStatus(next);
    if (current.occupied) {
      void notifyTelegramStatus("released", {
        previousOccupiedRoom: current.occupiedRoom || current.occupiedBy,
        reasonText: "освобождена вручную",
        updatedAt: next.updatedAt,
      });
    }

    return res.json(next);
  } catch (error) {
    return res.status(500).json({ error: "Не удалось освободить машинку." });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function start() {
  await ensureStorage();

  if (TELEGRAM_ENABLED) {
    process.stdout.write(`Telegram notifications enabled for chat ${TELEGRAM_CHAT_ID}\n`);
  }

  app.listen(PORT, () => {
    process.stdout.write(`Laundry status app started on port ${PORT}\n`);
  });
}

start().catch((error) => {
  process.stderr.write(`Startup error: ${error?.message || String(error)}\n`);
  process.exit(1);
});
