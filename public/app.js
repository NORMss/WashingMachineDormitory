const dom = {
  statusBadge: document.getElementById("status-badge"),
  statusMain: document.getElementById("status-main"),
  occupiedRoom: document.getElementById("occupied-room"),
  countdown: document.getElementById("countdown"),
  occupiedUntil: document.getElementById("occupied-until"),
  updatedAt: document.getElementById("updated-at"),
  roomsSuggestions: document.getElementById("rooms-suggestions"),
  roomQuickList: document.getElementById("room-quick-list"),
  historyList: document.getElementById("history-list"),
  historyEmpty: document.getElementById("history-empty"),
  flash: document.getElementById("flash"),
  occupyForm: document.getElementById("occupy-form"),
  occupyButton: document.getElementById("occupy-button"),
  occupiedRoomInput: document.getElementById("occupied-room-input"),
  minutesInput: document.getElementById("minutes-input"),
  releaseButton: document.getElementById("release-button"),
  pinDialog: document.getElementById("pin-dialog"),
  pinForm: document.getElementById("pin-form"),
  pinTitle: document.getElementById("pin-title"),
  pinSubtitle: document.getElementById("pin-subtitle"),
  pinDialogInput: document.getElementById("pin-dialog-input"),
  pinError: document.getElementById("pin-error"),
  pinCancelButton: document.getElementById("pin-cancel-button"),
};

const presetButtons = Array.from(document.querySelectorAll("[data-minutes]"));
const MAX_OCCUPY_MINUTES = 1440;
const ROOM_PATTERN = /^(?=.*\d)[0-9A-Za-zА-Яа-я\-_/]{1,16}$/u;

let currentStatus = null;
let hideFlashTimer = null;
let pendingPinAction = null;

function formatDateTime(isoDate) {
  if (!isoDate) return "—";
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatCountdown(ms) {
  if (ms <= 0) return "00:00";
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const paddedMinutes = String(minutes).padStart(2, "0");
  if (hours > 0) return `${hours} ч ${paddedMinutes} мин`;
  return `${paddedMinutes} мин`;
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "1 мин";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (!hours) return `${mins} мин`;
  if (!mins) return `${hours} ч`;
  return `${hours} ч ${mins} мин`;
}

function showFlash(message, isError = false) {
  dom.flash.textContent = message;
  dom.flash.classList.toggle("error", isError);
  if (hideFlashTimer) clearTimeout(hideFlashTimer);
  hideFlashTimer = setTimeout(() => {
    dom.flash.textContent = "";
    dom.flash.classList.remove("error");
  }, 3500);
}

function setOccupiedControls(isOccupied) {
  dom.occupyButton.disabled = isOccupied;
  dom.occupiedRoomInput.disabled = isOccupied;
  dom.minutesInput.disabled = isOccupied;
  presetButtons.forEach((button) => {
    button.disabled = isOccupied;
  });
}

function renderStatus(status) {
  currentStatus = status;

  dom.updatedAt.textContent = `Обновлено: ${formatDateTime(status.updatedAt)}`;

  if (status.occupied && status.occupiedUntil) {
    dom.statusBadge.textContent = "Занята";
    dom.statusBadge.classList.remove("free");
    dom.statusBadge.classList.add("busy");
    dom.statusMain.textContent = "Машинка занята";
    dom.occupiedRoom.textContent = status.occupiedRoom || status.occupiedBy || "—";
    dom.occupiedUntil.textContent = `Занята до: ${formatDateTime(status.occupiedUntil)}`;
    const leftMs = new Date(status.occupiedUntil).getTime() - Date.now();
    dom.countdown.textContent = formatCountdown(leftMs);
    setOccupiedControls(true);
    return;
  }

  dom.statusBadge.textContent = "Свободна";
  dom.statusBadge.classList.remove("busy");
  dom.statusBadge.classList.add("free");
  dom.statusMain.textContent = "Свободна, можно занять.";
  dom.occupiedRoom.textContent = "—";
  dom.occupiedUntil.textContent = "Занята до: —";
  dom.countdown.textContent = "—";
  setOccupiedControls(false);
}

function renderRoomSuggestions(items) {
  dom.roomsSuggestions.innerHTML = "";
  dom.roomQuickList.innerHTML = "";

  (items || []).forEach((room) => {
    const option = document.createElement("option");
    option.value = room;
    dom.roomsSuggestions.append(option);

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "room-chip";
    chip.textContent = room;
    chip.addEventListener("click", () => {
      if (dom.occupiedRoomInput.disabled) {
        return;
      }

      dom.occupiedRoomInput.value = room;
      dom.occupiedRoomInput.focus();
    });
    dom.roomQuickList.append(chip);
  });
}

function renderHistory(items) {
  dom.historyList.innerHTML = "";
  if (!items || items.length === 0) {
    dom.historyEmpty.style.display = "block";
    return;
  }

  dom.historyEmpty.style.display = "none";
  items.forEach((entry) => {
    const item = document.createElement("li");
    item.className = "history-item";

    const main = document.createElement("p");
    main.className = "history-main";
    const room = entry.occupiedRoom || entry.occupiedBy || "—";
    main.textContent = `Комната ${room} - ${formatDuration(entry.durationMinutes)}`;

    const meta = document.createElement("p");
    meta.className = "history-meta";
    meta.textContent = `${formatDateTime(entry.startedAt)} -> ${formatDateTime(entry.finishedAt)}`;

    item.append(main, meta);
    dom.historyList.append(item);
  });
}

async function request(url, payload) {
  const response = await fetch(url, {
    method: payload ? "POST" : "GET",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Ошибка запроса");
  return data;
}

async function refreshStatus() {
  const wasOccupied = Boolean(currentStatus?.occupied);
  try {
    const status = await request("/api/status");
    renderStatus(status);
    if (wasOccupied && !status.occupied) await refreshHistory();
  } catch (error) {
    showFlash(error.message || "Не удалось получить статус.", true);
  }
}

async function refreshHistory() {
  try {
    const history = await request("/api/history?limit=20");
    renderHistory(history.items || []);
  } catch (error) {
    showFlash(error.message || "Не удалось получить историю.", true);
  }
}

async function refreshRoomSuggestions() {
  try {
    const response = await request("/api/rooms?limit=40");
    renderRoomSuggestions(response.items || []);
  } catch (error) {
    showFlash(error.message || "Не удалось получить список комнат.", true);
  }
}

function openPinDialog(title, subtitle, handler) {
  pendingPinAction = handler;
  dom.pinTitle.textContent = title;
  dom.pinSubtitle.textContent = subtitle;
  dom.pinError.textContent = "";
  dom.pinDialogInput.value = "";
  dom.pinDialog.showModal();
  setTimeout(() => dom.pinDialogInput.focus(), 0);
}

function closePinDialog() {
  pendingPinAction = null;
  if (dom.pinDialog.open) {
    dom.pinDialog.close();
  }
}

function validateOccupyInput() {
  const occupiedRoom = dom.occupiedRoomInput.value.trim();
  const minutes = Number(dom.minutesInput.value);

  if (!occupiedRoom) {
    showFlash("Укажи номер комнаты.", true);
    dom.occupiedRoomInput.focus();
    return null;
  }

  if (!ROOM_PATTERN.test(occupiedRoom)) {
    showFlash("Комната: до 16 символов, только буквы/цифры и -, _, /, минимум 1 цифра.", true);
    dom.occupiedRoomInput.focus();
    return null;
  }

  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_OCCUPY_MINUTES) {
    showFlash(`Укажи целое число минут от 1 до ${MAX_OCCUPY_MINUTES}.`, true);
    dom.minutesInput.focus();
    return null;
  }

  return { occupiedRoom, minutes };
}

async function occupyMachine(pin, payload) {
  const status = await request("/api/status/occupy", {
    minutes: payload.minutes,
    occupiedRoom: payload.occupiedRoom,
    pin,
  });

  renderStatus(status);
  await refreshHistory();
  await refreshRoomSuggestions();
  showFlash("Машинка отмечена как занята.");
}

async function releaseMachine(pin) {
  const status = await request("/api/status/release", { pin });
  renderStatus(status);
  await refreshHistory();
  await refreshRoomSuggestions();
  showFlash("Машинка освобождена.");
}

dom.occupyForm.addEventListener("submit", (event) => {
  event.preventDefault();

  if (currentStatus?.occupied) {
    showFlash("Сейчас машинка занята. Занять нельзя.", true);
    return;
  }

  const payload = validateOccupyInput();
  if (!payload) return;

  openPinDialog("Занять машинку", "Введите PIN-код для подтверждения.", async (pin) => {
    await occupyMachine(pin, payload);
  });
});

dom.releaseButton.addEventListener("click", () => {
  if (!currentStatus?.occupied) {
    showFlash("Машинка уже свободна.", true);
    return;
  }

  openPinDialog("Освободить машинку", "Введите PIN-код для подтверждения.", async (pin) => {
    await releaseMachine(pin);
  });
});

dom.pinForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const pin = dom.pinDialogInput.value.trim();
  if (!pin) {
    dom.pinError.textContent = "Введите PIN-код.";
    dom.pinDialogInput.focus();
    return;
  }

  if (pin.length < 4 || pin.length > 32) {
    dom.pinError.textContent = "PIN-код должен быть от 4 до 32 символов.";
    dom.pinDialogInput.focus();
    return;
  }

  if (!pendingPinAction) {
    closePinDialog();
    return;
  }

  try {
    await pendingPinAction(pin);
    closePinDialog();
  } catch (error) {
    dom.pinError.textContent = error.message || "Не удалось выполнить действие.";
  }
});

dom.pinCancelButton.addEventListener("click", () => {
  closePinDialog();
});

presetButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    const minutes = Number(button.getAttribute("data-minutes"));
    dom.minutesInput.value = String(minutes);
    presetButtons.forEach((item) => item.classList.remove("is-active"));
    button.classList.add("is-active");
  });
});

dom.minutesInput.addEventListener("input", () => {
  presetButtons.forEach((item) => item.classList.remove("is-active"));
});

setInterval(() => {
  if (!currentStatus?.occupied || !currentStatus?.occupiedUntil) return;

  const leftMs = new Date(currentStatus.occupiedUntil).getTime() - Date.now();
  if (leftMs <= 0) {
    refreshStatus();
    return;
  }

  dom.countdown.textContent = formatCountdown(leftMs);
}, 1000);

setInterval(refreshStatus, 15000);
setInterval(refreshHistory, 45000);
setInterval(refreshRoomSuggestions, 90000);

refreshStatus();
refreshHistory();
refreshRoomSuggestions();
