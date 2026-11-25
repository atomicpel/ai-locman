package cloud.atomicpel.ailocman

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp

@Composable
internal fun ProjectsScreen(
    projects: List<WorkspaceProject>,
    activeProjectId: String,
    onSelect: (WorkspaceProject) -> Unit,
    onCreate: (String) -> Unit
) {
    var name by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 14.dp)) {
        Text("Проекты", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text("У каждого проекта своя история и отдельная память", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(16.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = name, onValueChange = { name = it },
                modifier = Modifier.weight(1f), singleLine = true,
                label = { Text("Название проекта") }
            )
            Spacer(Modifier.width(8.dp))
            Button(
                onClick = { onCreate(name.trim()); name = "" },
                enabled = name.isNotBlank(),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 16.dp)
            ) { Text("＋") }
        }
        Spacer(Modifier.height(14.dp))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            items(projects, key = { it.id }) { project ->
                Card(
                    modifier = Modifier.fillMaxWidth().clickable { onSelect(project) },
                    colors = CardDefaults.cardColors(
                        containerColor = if (project.id == activeProjectId) MaterialTheme.colorScheme.primaryContainer
                        else MaterialTheme.colorScheme.surfaceVariant
                    ),
                    shape = RoundedCornerShape(16.dp)
                ) {
                    Column(Modifier.padding(16.dp)) {
                        Text(project.name, fontWeight = FontWeight.SemiBold)
                        Text("Модель: ${project.model.substringAfterLast('/')}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (project.description.isNotBlank()) {
                            Text(project.description, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text(
                            if (project.id == activeProjectId) "Текущий проект" else "Открыть проект",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                }
            }
        }
    }
}

@Composable
internal fun HistoryScreen(
    conversations: List<WorkspaceConversation>,
    activeConversationId: String,
    onOpen: (WorkspaceConversation) -> Unit,
    onCreate: () -> Unit,
    onRename: (WorkspaceConversation) -> Unit,
    onDelete: (WorkspaceConversation) -> Unit
) {
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("История чатов", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Text("Переписки сохраняются внутри выбранного проекта", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Button(onClick = onCreate, contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp)) {
                Text("＋ Чат")
            }
        }
        Spacer(Modifier.height(14.dp))
        if (conversations.isEmpty()) {
            Text("Пока нет переписок. Создай новый чат.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                items(conversations, key = { it.id }) { conversation ->
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = if (conversation.id == activeConversationId) MaterialTheme.colorScheme.primaryContainer
                            else MaterialTheme.colorScheme.surfaceVariant
                        ),
                        shape = RoundedCornerShape(16.dp)
                    ) {
                        Column(Modifier.padding(13.dp)) {
                            Text(
                                conversation.title,
                                modifier = Modifier.fillMaxWidth().clickable { onOpen(conversation) },
                                fontWeight = FontWeight.SemiBold
                            )
                            if (conversation.preview.isNotBlank()) {
                                Text(
                                    conversation.preview,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 2,
                                    modifier = Modifier.clickable { onOpen(conversation) }.padding(top = 4.dp)
                                )
                            }
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                TextButton(onClick = { onOpen(conversation) }) { Text("Открыть") }
                                TextButton(onClick = { onRename(conversation) }) { Text("Переименовать") }
                                TextButton(onClick = { onDelete(conversation) }) { Text("Удалить") }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun MemoryScreen(
    initial: WorkspaceMemory,
    onSave: (WorkspaceMemory) -> Unit
) {
    var architecture by remember(initial) { mutableStateOf(initial.architecture) }
    var decisions by remember(initial) { mutableStateOf(initial.decisions) }
    var knowledge by remember(initial) { mutableStateOf(initial.knowledge) }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("Память проекта", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text("Эти сведения используются как контекст при новых запросах. Память других проектов сюда не попадает.",
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(
            value = architecture, onValueChange = { architecture = it },
            modifier = Modifier.fillMaxWidth(), minLines = 4,
            label = { Text("Архитектура") },
            placeholder = { Text("Стек, структура, компоненты и связи") }
        )
        OutlinedTextField(
            value = decisions, onValueChange = { decisions = it },
            modifier = Modifier.fillMaxWidth(), minLines = 4,
            label = { Text("Принятые решения") },
            placeholder = { Text("Что решили и почему") }
        )
        OutlinedTextField(
            value = knowledge, onValueChange = { knowledge = it },
            modifier = Modifier.fillMaxWidth(), minLines = 4,
            label = { Text("Знания проекта") },
            placeholder = { Text("Команды, особенности, ограничения, полезные факты") }
        )
        Button(
            onClick = { onSave(WorkspaceMemory(architecture, decisions, knowledge)) },
            modifier = Modifier.fillMaxWidth().height(52.dp)
        ) { Text("Сохранить память", fontWeight = FontWeight.Bold) }
    }
}


@Composable
internal fun TasksScreen(
    tasks: List<WorkspaceTask>,
    backendAvailable: Boolean,
    busy: Boolean,
    onRefresh: () -> Unit,
    onCancel: (WorkspaceTask) -> Unit,
    onOpenResult: (WorkspaceTask) -> Unit
) {
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Фоновые задачи", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Text(
                    "Задачи продолжаются на сервере, даже когда приложение закрыто",
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            TextButton(onClick = onRefresh, enabled = !busy) { Text("Обновить") }
        }
        Spacer(Modifier.height(12.dp))
        if (!backendAvailable) {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                Column(Modifier.padding(16.dp)) {
                    Text("Нужен Backend", fontWeight = FontWeight.SemiBold)
                    Text(
                        "Фоновые задачи доступны в режиме Backend. В Local AI запросы выполняются непосредственно с телефона.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        } else if (tasks.isEmpty()) {
            Text("Пока нет фоновых задач.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(tasks, key = { it.id }) { task ->
                    val terminal = task.status in listOf("completed", "failed", "cancelled")
                    val statusText = when (task.status) {
                        "queued" -> "В очереди"
                        "planning" -> "Подготовка"
                        "running" -> "Выполняется"
                        "waiting_approval" -> "Ожидает подтверждения"
                        "testing" -> "Проверка"
                        "completed" -> "Завершена"
                        "failed" -> "Ошибка"
                        "cancelled" -> "Отменена"
                        else -> task.status
                    }
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                        shape = RoundedCornerShape(16.dp)
                    ) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(statusText, modifier = Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                                Text(task.model.substringAfterLast('/'), style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                            }
                            Text(task.prompt, maxLines = 3)
                            if (task.result.isNotBlank()) {
                                HorizontalDivider()
                                Text(task.result, maxLines = 5, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (task.error.isNotBlank()) {
                                Text(task.error, color = MaterialTheme.colorScheme.error, maxLines = 4)
                            }
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                if (task.status == "completed" && task.conversationId.isNotBlank()) {
                                    TextButton(onClick = { onOpenResult(task) }) { Text("Открыть диалог") }
                                }
                                if (!terminal) {
                                    TextButton(onClick = { onCancel(task) }) { Text("Отменить") }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}


@Composable
internal fun GitHubScreen(
    backendAvailable: Boolean,
    server: String,
    connected: Boolean,
    installations: List<WorkspaceGitHubInstallation>,
    repositories: List<WorkspaceGitHubRepository>,
    selectedRepository: WorkspaceGitHubRepository?,
    branches: List<WorkspaceGitHubBranch>,
    selectedBranch: String,
    currentPath: String,
    files: List<WorkspaceGitHubContent>,
    selectedFilePath: String,
    selectedFileContent: String,
    busy: Boolean,
    onRefresh: () -> Unit,
    onSelectRepository: (WorkspaceGitHubRepository) -> Unit,
    onBackToRepositories: () -> Unit,
    onSelectBranch: (String) -> Unit,
    onNavigateDirectory: (String) -> Unit,
    onOpenFile: (WorkspaceGitHubContent) -> Unit,
    onCloseFile: () -> Unit,
    onUpPath: () -> Unit
) {
    val uriHandler = LocalUriHandler.current
    var branchMenu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("GitHub", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Text(
                    if (connected) "Подключение установлено" else "Подключение репозиториев",
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            TextButton(onClick = onRefresh, enabled = backendAvailable && !busy) { Text("Обновить") }
        }
        Spacer(Modifier.height(12.dp))
        if (!backendAvailable) {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Нужен Backend", fontWeight = FontWeight.SemiBold)
                    Text("GitHub App подключается на сервере. Переключись в режим Backend и укажи доступный адрес сервера.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        } else if (!connected) {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Подключи GitHub App", fontWeight = FontWeight.SemiBold)
                    Text("Backend откроет GitHub, где можно установить приложение и выбрать репозитории. После установки вернись сюда и нажми «Обновить».",
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Button(
                        onClick = { uriHandler.openUri(server.trimEnd('/') + "/api/v1/github/connect") },
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("Установить GitHub App") }
                }
            }
        } else if (selectedRepository == null) {
            if (installations.isNotEmpty()) {
                Text(
                    "Установки: " + installations.joinToString { it.accountLogin },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall
                )
                Spacer(Modifier.height(10.dp))
            }
            if (repositories.isEmpty()) {
                Text("GitHub App установлено, но доступных репозиториев не найдено.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Text("Репозитории (\${repositories.size})", fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(8.dp))
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(repositories, key = { it.id }) { repository ->
                        Card(
                            modifier = Modifier.fillMaxWidth().clickable { onSelectRepository(repository) },
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                            shape = RoundedCornerShape(14.dp)
                        ) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(repository.fullName, modifier = Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                                    Text(if (repository.isPrivate) "Private" else "Public",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                if (repository.description.isNotBlank()) {
                                    Text(repository.description, maxLines = 2, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        style = MaterialTheme.typography.bodySmall)
                                }
                                Text("Ветка: \${repository.defaultBranch}", color = MaterialTheme.colorScheme.primary,
                                    style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                }
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onBackToRepositories) { Text("← Репозитории") }
                Spacer(Modifier.width(6.dp))
                Text(selectedRepository.fullName, fontWeight = FontWeight.SemiBold, maxLines = 1)
            }
            Spacer(Modifier.height(8.dp))
            Box {
                OutlinedButton(onClick = { branchMenu = true }, enabled = branches.isNotEmpty() && !busy) {
                    Text("Ветка: \${selectedBranch.ifBlank { selectedRepository.defaultBranch }}")
                }
                DropdownMenu(expanded = branchMenu, onDismissRequest = { branchMenu = false }) {
                    branches.forEach { branch ->
                        DropdownMenuItem(
                            text = { Text(branch.name + if (branch.isProtected) " · protected" else "") },
                            onClick = { branchMenu = false; onSelectBranch(branch.name) }
                        )
                    }
                }
            }
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(currentPath.ifBlank { "/" }, modifier = Modifier.weight(1f),
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                if (currentPath.isNotBlank()) TextButton(onClick = onUpPath) { Text("Вверх") }
            }
            if (selectedFilePath.isNotBlank()) {
                TextButton(onClick = onCloseFile) { Text("← К списку файлов") }
                Card(Modifier.fillMaxWidth().weight(1f),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                    Text(selectedFileContent, modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(12.dp),
                        style = MaterialTheme.typography.bodySmall)
                }
            } else {
                LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(files, key = { it.path }) { item ->
                        Row(
                            Modifier.fillMaxWidth().clickable {
                                if (item.type == "dir") onNavigateDirectory(item.path) else onOpenFile(item)
                            }.padding(vertical = 8.dp, horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(if (item.type == "dir") "📁" else "📄")
                            Spacer(Modifier.width(10.dp))
                            Text(item.name, modifier = Modifier.weight(1f), maxLines = 1)
                            if (item.size > 0) Text("\${item.size} B", style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    }
                }
            }
        }
        if (busy) {
            Spacer(Modifier.height(8.dp))
            LinearProgressIndicator(Modifier.fillMaxWidth())
        }
    }
}
