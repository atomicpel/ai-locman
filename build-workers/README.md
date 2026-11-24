# Build Workers

Здесь будет исполнитель сборок. В текущем MVP команды не принимаются из API и произвольный shell не включён.

Production требования:
- отдельный одноразовый контейнер на задачу;
- rootless runtime, seccomp/AppArmor;
- запрет privileged и host mounts;
- отсутствие Docker socket;
- ограничения CPU/RAM/PID/disk/time;
- сетевой egress allowlist и запрет доступа к metadata/private networks;
- очищение workspace и секретов после завершения;
- артефакты передавать через ограниченный upload API.
