# Build Workers

Здесь будет исполнитель сборок. В текущем MVP команды не принимаются из API и произвольный shell не включён.

## Текущее состояние

- Изолированный runtime ещё не развёрнут; `DisabledSandboxController` всегда отказывает в запуске.
- API и Worker разрешены только при явном `NODE_ENV=development`; production и unset environment завершаются fail-closed.
- GitHub tools в агенте read-only.
- Подтверждения команд хранятся как одноразовые, ограниченные по времени challenge и привязаны к задаче, проекту, репозиторию, commit, argv и SHA-256 diff. Они пока не включают исполнение.
- Метаданные артефактов проходят отдельную проверку пути, hash, количества и размера.
- Добавлен локальный content-addressed storage primitive: запись по task UUID + SHA-256, проверка размера/hash до записи и при чтении, права каталогов/файлов ограничены, имена sandbox-файлов не используются как disk paths.
- Metadata migration `009_task_artifacts.sql` создаёт таблицу с FK на task/project, уникальностью пути в задаче и индексом для выборки.
- API предоставляет owner-scoped listing и binary download (`application/octet-stream`, `private, no-store`); backend и worker используют отдельный persistent Docker volume.
- Репозиторий артефактов проверяет владельца задачи до записи байтов и повторно под блокировкой транзакции; скачивание повторно проверяет owner и SHA-256.
- Важно: ingestion endpoint из sandbox/runner и retention/garbage collection ещё не реализованы; execution runtime остаётся отключённым.

## Production требования

- отдельный одноразовый контейнер на задачу;
- rootless OCI runtime с seccomp/AppArmor;
- запрет privileged и host mounts;
- отсутствие Docker socket внутри API и Worker;
- ограничения CPU/RAM/PID/disk/time;
- сетевой egress allowlist и запрет доступа к metadata/private networks;
- checkout только по immutable commit SHA;
- короткоживущие секреты только на время checkout, не в окружении процесса сборки;
- очистка workspace и секретов после завершения;
- артефакты передавать через ограниченный upload API, проверять SHA-256 и размер до сохранения.

Пока все перечисленные runtime-контроли не реализованы и не проверены, исполнение остаётся отключённым.
