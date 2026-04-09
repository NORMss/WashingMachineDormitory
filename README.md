# Laundry Status Web

Простое веб-приложение для общежития: показывает, занята стиральная машина или нет, и до какого времени.

## Что умеет

- Показывает текущий статус: свободна/занята.
- Показывает, какая комната заняла машинку.
- Показывает время, до которого машинка занята.
- Показывает обратный отсчет.
- Позволяет быстро занять машинку на 30/45/60/90 минут.
- Позволяет указать свою длительность в минутах.
- Подсказывает список комнат на основе истории.
- Запрашивает PIN-код в диалоговом окне после нажатия на действие.
- Блокирует повторное занятие, если машинка уже занята.
- Позволяет освободить машинку вручную.
- Защищает изменение статуса через PIN-код.
- Ведет историю завершенных стирок.

## Технологии

- Node.js + Express
- Чистый HTML/CSS/JavaScript (без фреймворка)
- Хранение статуса и истории в JSON-файлах (`data/status.json`, `data/history.json`)

## Переменные и файлы

- `STATUS_PIN` - PIN-код для изменения статуса (рекомендуется задавать через `.env` или переменные окружения)
- `TELEGRAM_BOT_TOKEN` - токен Telegram-бота (опционально, для уведомлений)
- `TELEGRAM_CHAT_ID` - ID общего чата/канала для уведомлений
- `TELEGRAM_API_BASE_URL` - базовый URL Telegram API (по умолчанию `https://api.telegram.org`)
- `config.json` - локальный fallback для PIN, не храните его в git
- `data/status.json`, `data/history.json` - рабочие данные приложения, не храните их в git

Если `config.json` случайно создан как директория, можно не использовать его вообще и задавать PIN только через `STATUS_PIN`.

## Запуск локально

1. Установить зависимости:

```bash
npm install
```

2. Запустить сервер:

```bash
npm start
```

По умолчанию PIN-код: `1234`. Рекомендуемый способ изменить его - переменная окружения `STATUS_PIN`.

3. Открыть в браузере:

```text
http://localhost:3000
```

## Запуск на сервере

1. Скопировать проект на сервер.
2. Установить Node.js 18+.
3. Выполнить:

```bash
npm install
STATUS_PIN=myStrongPin PORT=3000 npm start
```

Если используете Nginx/Caddy, настройте reverse proxy на порт `3000`.

## Полная установка на чистый Ubuntu сервер

Ниже путь с Docker Compose (рекомендуется).

### 0) Подготовка DNS

1. У домена (например, `wash.example.com`) добавьте `A`-запись на IP сервера.
2. Подождите, пока DNS обновится.

### 1) Обновить систему

```bash
sudo apt update && sudo apt upgrade -y
```

### 2) Установить Docker и Docker Compose plugin

```bash
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```

Перелогиньтесь (или `newgrp docker`), затем проверьте:

```bash
docker --version
docker compose version
```

### 3) Скопировать проект на сервер

Вариант через git:

```bash
git clone <URL_ВАШЕГО_РЕПО> laundry-status-web
cd laundry-status-web
```

Или загрузите архивом и перейдите в папку проекта.

### 4) Подготовить env и запуск контейнера

```bash
cp .env.example .env
```

Откройте `.env` и задайте сложный PIN:

```text
STATUS_PIN=очень_сложный_pin
```

Запуск:

```bash
docker compose up -d --build
```

Проверка:

```bash
docker compose ps
docker compose logs -f
```

### 5) Установить Nginx

```bash
sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

### 6) Настроить reverse proxy для домена

Создайте файл:

```bash
sudo nano /etc/nginx/sites-available/laundry-status
```

Содержимое:

```nginx
server {
    listen 80;
    server_name wash.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Активировать:

```bash
sudo ln -s /etc/nginx/sites-available/laundry-status /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 7) Подключить HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d wash.example.com
```

Проверьте автообновление сертификатов:

```bash
sudo systemctl status certbot.timer
```

### 8) Открыть порт в firewall (если UFW включен)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

### 9) Обновление приложения

```bash
cd laundry-status-web
git pull
docker compose up -d --build
```

### 10) Полезная диагностика

```bash
docker compose ps
docker compose logs -f
sudo nginx -t
sudo journalctl -u nginx -f
```

## Docker Compose

1. Скопируй пример env-файла:

```bash
cp .env.example .env
```

2. При необходимости измени PIN в `.env`:

```text
STATUS_PIN=твой_pin
```

Для Telegram-уведомлений добавьте в `.env`:

```text
TELEGRAM_BOT_TOKEN=123456789:ABCDEF...
TELEGRAM_CHAT_ID=-1001234567890
TELEGRAM_API_BASE_URL=https://api.telegram.org
```

Если Telegram на сервере доступен только через ваш прокси (например, через x-ui), задайте `TELEGRAM_API_BASE_URL` на этот прокси-URL.

3. Запусти через Docker Compose:

```bash
docker compose up -d --build
```

4. Открой в браузере:

```text
http://localhost:3000
```

## API

- `GET /api/status` - получить статус
- `GET /api/history?limit=20` - получить историю стирок
- `GET /api/rooms?limit=40` - получить список комнат для подсказок
- `POST /api/status/occupy` - занять машинку
  - body: `{ "minutes": 60, "occupiedRoom": "417", "pin": "1234" }`
  - `occupiedRoom`: до 16 символов, минимум 1 цифра, разрешены буквы/цифры/`-`/`_`/`/`
  - если машинка занята: `409 Conflict`
- `POST /api/status/release` - освободить машинку
  - body: `{ "pin": "1234" }`

История хранится в `data/history.json`, текущий статус в `data/status.json`.

## Telegram-бот: уведомления в общий чат

Приложение может отправлять уведомления о смене статуса машинки в Telegram.

### Что отправляется

- Когда машинка занята (`occupied`)
- Когда машинка освобождена вручную (`released`)
- Когда машинка освобождена автоматически по таймеру

### Как настроить

1. Создайте бота через `@BotFather` и получите токен.
2. Добавьте бота в ваш общий чат (группу или канал).
3. Дайте боту право писать сообщения (для канала - добавьте как администратора).
4. Узнайте `chat_id`:
   - отправьте любое сообщение в чат,
   - откройте в браузере `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`,
   - найдите `chat.id`.
5. Запишите `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` в `.env`.
   - если используете проксирование Telegram через x-ui/свой gateway, задайте `TELEGRAM_API_BASE_URL`.
6. Перезапустите сервис:

```bash
docker compose up -d --force-recreate
```

Если `TELEGRAM_BOT_TOKEN` или `TELEGRAM_CHAT_ID` не заданы, уведомления отключены.

Для x-ui/прокси Telegram API:

- Укажите, например, `TELEGRAM_API_BASE_URL=https://your-domain.example/telegram`.
- Сервер должен проксировать путь `/bot<TOKEN>/sendMessage` к Telegram Bot API.
