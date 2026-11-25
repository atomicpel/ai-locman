# Подключение GitHub App

Backend поддерживает установку GitHub App и read-only доступ к выбранным репозиториям. Personal Access Token в Android вводить не нужно.

## 1. Создать GitHub App

В GitHub открой Settings → Developer settings → GitHub Apps → New GitHub App.

Задай:
- GitHub App name — например AI Locman.
- Homepage URL — адрес backend.
- Setup URL — https://YOUR-BACKEND/api/v1/github/callback.
- Установку разреши на личный аккаунт или нужные организации.

Для первого этапа достаточно read-only разрешений:
- Repository permissions → Metadata: Read-only.
- Repository permissions → Contents: Read-only.
- Repository permissions → Pull requests: Read-only.
- Repository permissions → Actions: Read-only.

Не выдавай Contents write или Administration write на этом этапе. Запись и merge ещё не реализованы; будущие операции должны требовать подтверждения.

Сохрани App slug, Client ID и сгенерируй Private key. Client ID и App ID — разные значения; в JWT используется Client ID.

## 2. Добавить настройки на backend

Скопируй .env.example в .env в корне проекта и заполни:
- APP_PUBLIC_URL — внешний адрес backend, доступный браузеру телефона.
- GITHUB_APP_SLUG — slug приложения из URL GitHub App.
- GITHUB_APP_CLIENT_ID — Client ID.
- GITHUB_APP_PRIVATE_KEY — PEM private key; переводы строк в .env можно представить последовательностями \n.

Private key нельзя добавлять в Git, APK, сообщения или настройки Android. Он хранится только на backend.

Перезапусти Docker Compose. Таблицы GitHub installation/state создаются автоматически и также добавлены в миграцию 005_github_installations.sql.

## 3. Подключить репозитории

В Backend-режиме открой в браузере:
https://YOUR-BACKEND/api/v1/github/connect

GitHub предложит установить приложение. Выбери только те репозитории, с которыми должен работать AI Locman. После установки GitHub вернёт браузер на Setup URL. Backend проверяет installation_id подписанным JWT, сохраняет только ID установки и данные аккаунта, но не сохраняет installation access token.

После успешной установки доступны API:
- GET /api/v1/github/status
- GET /api/v1/github/repositories
- GET /api/v1/github/repositories/{owner}/{repo}
- GET /api/v1/github/repositories/{owner}/{repo}/branches
- GET /api/v1/github/repositories/{owner}/{repo}/contents?path=...&ref=...
- GET /api/v1/github/repositories/{owner}/{repo}/commits
- GET /api/v1/github/repositories/{owner}/{repo}/pulls
- GET /api/v1/github/repositories/{owner}/{repo}/actions
- GET /api/v1/github/repositories/{owner}/{repo}/compare?base=...&head=...

Installation access token создаётся backend при API-запросе и не передаётся Android. GitHub ограничивает такой токен одной установкой и сроком действия в один час.

## Ограничения текущего этапа

Backend endpoints read-only. Android repository picker и браузер кода ещё подключаются. Создание веток, коммиты, запись файлов и PR ещё не реализованы. Пока backend использует development owner без аутентификации, не публикуй его в интернет и не используй на недоверенной сети.
