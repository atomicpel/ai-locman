# AI Locman

Мобильная AI-студия разработки: Android-клиент + TypeScript backend + OpenRouter.

> Стартовый каркас v0.2.0. Это MVP foundation, не production-релиз и пока не автономный программист.

## Текущий состав проекта

- Android-клиент на Kotlin + Jetpack Compose.
- Backend API на TypeScript/Fastify.
- PostgreSQL для проектов и истории сообщений.
- OpenRouter как первый LLM-провайдер.
- Docker Compose для локальной инфраструктуры.
- GitHub Actions для проверки backend и сборки Android.

## План

1. Надёжный Android workspace и история чатов.
2. GitHub OAuth/App и управление репозиториями.
3. Агентный цикл: планирование → инструменты → независимая проверка → тесты.
4. Очередь фоновых задач и возобновление сессий.
5. Изолированные build workers и выдача APK/установщиков.

## Безопасность

Текущий MVP использует фиксированного dev-пользователя и не подходит для публичного размещения. Не выставляйте backend в интернет. До удалённого развёртывания обязательны аутентификация, TLS, разграничение доступа и безопасное хранение секретов.

Подробности будут в `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_PLAN.md` и `docs/SECURITY_MODEL.md`.
