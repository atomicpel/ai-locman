# Архитектура AI Locman

## Принцип
Android — интерфейс и удалённый пульт. Backend — доверенная control plane. Agent Core планирует и вызывает только allowlisted tools. Build Worker запускает код в отдельной одноразовой среде.

## Поток задачи
1. Android отправляет задачу с projectId.
2. API проверяет пользователя и доступ к проекту.
3. Задача сохраняется в PostgreSQL и ставится в Redis/BullMQ.
4. Agent Core загружает только контекст указанного проекта.
5. Model Router вызывает выбранную модель через OpenRouter.
6. Tool Registry валидирует вызовы; Permission Engine применяет политику.
7. Build Worker выполняет разрешённые команды в sandbox.
8. События и артефакты сохраняются, клиент получает обновления.

## Изоляция и безопасность
- Секреты только на сервере; Android не получает OpenRouter/GitHub tokens.
- GitHub OAuth/GitHub App с минимальными правами и выбором репозиториев.
- Изменения сначала в отдельной ветке.
- Push в protected/default branch, merge, удаление и изменение секретов требуют approval.
- Worker: non-root, read-only base image, ограничения CPU/RAM/disk/time, без Docker socket и доступа к внутренним сетям.
- Содержимое репозитория считается недоверенным вводом; prompt injection не меняет системную политику.

## Размещение
Пока не фиксируется. Локальная разработка через Docker Compose; позднее можно развернуть на VPS или собственном сервере.
