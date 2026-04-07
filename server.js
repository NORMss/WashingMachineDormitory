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

function createDefaultStatus() {
  return {
    occupied: false,
    occupiedUntil: null,
    occupiedFrom: null,
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

  try {
    await fs.access(CONFIG_FILE);
  } catch {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(createDefaultConfig(), null, 2));
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
  const occupiedByValue =
    typeof rawStatus?.occupiedBy === "string" && rawStatus.occupiedBy.trim().length > 0
      ? rawStatus.occupiedBy.trim().slice(0, 64)
      : null;

  const hasValidOccupiedState = occupied && Boolean(occupiedUntilValue) && Boolean(occupiedByValue);

  return {
    occupied: hasValidOccupiedState,
    occupiedUntil: hasValidOccupiedState ? occupiedUntilValue : null,
    occupiedFrom: hasValidOccupiedState ? occupiedFromValue : null,
    occupiedBy: hasValidOccupiedState ? occupiedByValue : null,
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
  const occupiedBy =
    typeof rawEntry?.occupiedBy === "string" && rawEntry.occupiedBy.trim().length > 0
      ? rawEntry.occupiedBy.trim().slice(0, 64)
      : null;
  const plannedUntil =
    typeof rawEntry?.plannedUntil === "string" && !Number.isNaN(Date.parse(rawEntry.plannedUntil))
      ? rawEntry.plannedUntil
      : null;
  const endReason = ["manual", "auto", "replaced"].includes(rawEntry?.endReason)
    ? rawEntry.endReason
    : "manual";
  const durationMinutes = Number(rawEntry?.durationMinutes);

  if (!startedAt || !finishedAt || !occupiedBy) {
    return null;
  }

  return {
    id: typeof rawEntry?.id === "string" && rawEntry.id.trim() ? rawEntry.id.trim() : randomUUID(),
    occupiedBy,
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

async function readStatus() {
  await ensureStorage();
  const rawFile = await fs.readFile(STATUS_FILE, "utf-8");
  const parsed = JSON.parse(rawFile);
  return sanitizeStatus(parsed);
}

async function readConfig() {
  await ensureStorage();
  const rawFile = await fs.readFile(CONFIG_FILE, "utf-8");
  const parsed = JSON.parse(rawFile);
  return sanitizeConfig(parsed);
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
  if (!status.occupied || !status.occupiedBy || !status.occupiedUntil) {
    return null;
  }

  const startedAt = status.occupiedFrom || status.updatedAt || finishedAt;
  const startedAtMs = Date.parse(startedAt);
  const finishedAtMs = Date.parse(finishedAt);
  const isValidRange = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs) && finishedAtMs >= startedAtMs;
  const durationMinutes = isValidRange ? Math.max(1, Math.round((finishedAtMs - startedAtMs) / 60000)) : 1;

  return {
    id: randomUUID(),
    occupiedBy: status.occupiedBy,
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
    occupiedBy: null,
    updatedAt: new Date().toISOString(),
  };

  await appendHistoryFromStatus(status, status.occupiedUntil, "auto");

  await writeStatus(releasedStatus);
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

app.post("/api/status/occupy", async (req, res) => {
  const minutes = Number(req.body?.minutes);
  const occupiedBy = typeof req.body?.occupiedBy === "string" ? req.body.occupiedBy.trim() : "";

  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_OCCUPY_MINUTES) {
    return res.status(400).json({
      error: `Укажите целое число минут от 1 до ${MAX_OCCUPY_MINUTES}.`,
    });
  }

  if (!occupiedBy || occupiedBy.length > 64) {
    return res.status(400).json({
      error: "Укажите, кем занята машинка (от 1 до 64 символов).",
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
        occupiedBy: current.occupiedBy,
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
      occupiedBy,
      updatedAt: new Date().toISOString(),
    };

    await writeStatus(next);
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
      occupiedBy: null,
      updatedAt: new Date().toISOString(),
    };

    await writeStatus(next);
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
  app.listen(PORT, () => {
    process.stdout.write(`Laundry status app started on port ${PORT}\n`);
  });
}

start().catch((error) => {
  process.stderr.write(`Startup error: ${error?.message || String(error)}\n`);
  process.exit(1);
});
