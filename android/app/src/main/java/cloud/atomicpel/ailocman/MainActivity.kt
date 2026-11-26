package cloud.atomicpel.ailocman

import android.os.Bundle
import android.util.Base64
import android.content.SharedPreferences
import java.util.UUID
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

private val Navy = Color(0xFF0A1020)
private val Panel = Color(0xFF141F33)
private val Panel2 = Color(0xFF1B2940)
private val Accent = Color(0xFF6EE7D2)
private val Blue = Color(0xFF8DB8FF)
private val Muted = Color(0xFF9AAAC2)
private val MainText = Color(0xFFEAF0FA)

private data class ChatLine(val role: String, val text: String)
private data class ModelInfo(val id: String, val name: String, val context: Int)

private object BackendSession {
    var tokenProvider: (() -> String?)? = null
    fun token(): String? = runCatching { tokenProvider?.invoke() }.getOrNull()?.takeIf { it.isNotBlank() }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("ai_locman", MODE_PRIVATE)
        val securePrefs = runCatching {
            val masterKey = MasterKey.Builder(this).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            @Suppress("DEPRECATION")
            EncryptedSharedPreferences.create(
                this, "ai_locman_secure", masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        }.getOrNull()

        BackendSession.tokenProvider = { securePrefs?.getString("backend_session", null) }
        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = Accent, secondary = Blue, background = Navy,
                    surface = Panel, onBackground = MainText, onSurface = MainText
                )
            ) {
                LocmanApp(
                    preferences = prefs,
                    initialServer = prefs.getString("server", "http://10.0.2.2:8080") ?: "http://10.0.2.2:8080",
                    initialModel = prefs.getString("model", "openai/gpt-4o-mini") ?: "openai/gpt-4o-mini",
                    initialKey = securePrefs?.getString("openrouter_key", "") ?: "",
                    initialBackendAuthenticated = securePrefs?.getString("backend_session", null) != null,
                    initialLocalMode = prefs.getBoolean("local_mode", true),
                    initialProject = prefs.getString("project", "Мой первый проект") ?: "Мой первый проект",
                    onSaveSettings = { server, model, local, project ->
                        prefs.edit().putString("server", server).putString("model", model)
                            .putBoolean("local_mode", local).putString("project", project).apply()
                    },
                    onSaveKey = { key -> securePrefs?.edit()?.putString("openrouter_key", key)?.apply() },
                    onSaveBackendSession = { token -> checkNotNull(securePrefs) { "Защищённое хранилище Android недоступно" }.edit().putString("backend_session", token).apply() },
                    onClearBackendSession = { securePrefs?.edit()?.remove("backend_session")?.apply() }
                )
            }
        }
    }
}

@Composable
private fun LocmanApp(
    preferences: SharedPreferences,
    initialServer: String,
    initialModel: String,
    initialKey: String,
    initialBackendAuthenticated: Boolean,
    initialLocalMode: Boolean,
    initialProject: String,
    onSaveSettings: (String, String, Boolean, String) -> Unit,
    onSaveKey: (String) -> Unit,
    onSaveBackendSession: (String) -> Unit,
    onClearBackendSession: () -> Unit
) {
    var screen by remember { mutableStateOf("chat") }
    var navigationExpanded by remember { mutableStateOf(false) }
    var editingConversation by remember { mutableStateOf<WorkspaceConversation?>(null) }
    var renameValue by remember { mutableStateOf("") }
    var deletingConversation by remember { mutableStateOf<WorkspaceConversation?>(null) }
    var localMode by remember { mutableStateOf(initialLocalMode) }
    var server by remember { mutableStateOf(initialServer) }
    var projectName by remember { mutableStateOf(initialProject) }
    var model by remember { mutableStateOf(initialModel) }
    var apiKey by remember { mutableStateOf(initialKey) }
    var backendAuthenticated by remember { mutableStateOf(initialBackendAuthenticated) }
    var backendPassword by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("Готов к работе") }
    var models by remember { mutableStateOf<List<ModelInfo>>(emptyList()) }
    var modelSearch by remember { mutableStateOf("") }
    var showModelPicker by remember { mutableStateOf(false) }
    var tasks by remember { mutableStateOf<List<WorkspaceTask>>(emptyList()) }
    val monitoredTaskIds = remember { mutableStateListOf<String>() }
    var githubConnected by remember { mutableStateOf(false) }
    var githubInstallations by remember { mutableStateOf<List<WorkspaceGitHubInstallation>>(emptyList()) }
    var githubRepositories by remember { mutableStateOf<List<WorkspaceGitHubRepository>>(emptyList()) }
    var selectedGithubRepository by remember { mutableStateOf<WorkspaceGitHubRepository?>(null) }
    var githubBranches by remember { mutableStateOf<List<WorkspaceGitHubBranch>>(emptyList()) }
    var selectedGithubBranch by remember { mutableStateOf("") }
    var githubPath by remember { mutableStateOf("") }
    var githubFiles by remember { mutableStateOf<List<WorkspaceGitHubContent>>(emptyList()) }
    var githubSelectedFilePath by remember { mutableStateOf("") }
    var githubFileContent by remember { mutableStateOf("") }
    var githubSection by remember { mutableStateOf("files") }
    var githubCommits by remember { mutableStateOf<List<WorkspaceGitHubCommit>>(emptyList()) }
    var githubPulls by remember { mutableStateOf<List<WorkspaceGitHubPull>>(emptyList()) }
    var githubWorkflowRuns by remember { mutableStateOf<List<WorkspaceGitHubRun>>(emptyList()) }
    var githubDiff by remember { mutableStateOf("") }
    val initialProjects = remember { WorkspaceStore.ensureProjects(preferences) }
    var projects by remember { mutableStateOf(initialProjects) }
    var projectId by remember {
        mutableStateOf(preferences.getString("active_project_id", initialProjects.first().id) ?: initialProjects.first().id)
    }
    var conversations by remember { mutableStateOf(WorkspaceStore.loadConversations(preferences, projectId)) }
    var conversationId by remember {
        mutableStateOf(
            (preferences.getString("active_conversation_$projectId", "") ?: "")
                .ifBlank { conversations.firstOrNull()?.id.orEmpty() }
        )
    }
    var conversationTitle by remember {
        mutableStateOf(conversations.firstOrNull { it.id == conversationId }?.title ?: "Новый чат")
    }
    val lines = remember {
        mutableStateListOf<ChatLine>().apply {
            addAll(WorkspaceStore.loadMessages(preferences, projectId, conversationId).map { ChatLine(it.role, it.content) })
            if (isEmpty()) add(ChatLine("assistant", "Привет! Я Лоцман. Чем займёмся сегодня?"))
        }
    }
    var memory by remember(projectId) { mutableStateOf(WorkspaceStore.loadMemory(preferences, projectId)) }
    val scope = rememberCoroutineScope()

    fun runTask(block: suspend () -> Unit) {
        if (busy) return
        scope.launch {
            busy = true
            try { block() } catch (e: Exception) { status = e.message ?: "Неизвестная ошибка" }
            finally { busy = false }
        }
    }

    fun monitorBackendTask(taskId: String) {
        if (localMode || taskId in monitoredTaskIds) return
        val taskProjectId = projectId
        monitoredTaskIds.add(taskId)
        scope.launch {
            try {
                while (true) {
                    val current = loadBackendTask(server, taskId)
                    if (projectId == taskProjectId) {
                        tasks = (tasks.filterNot { it.id == current.id } + current)
                    }
                    if (current.status in listOf("completed", "failed", "cancelled")) {
                        if (projectId == taskProjectId) {
                            status = when (current.status) {
                                "completed" -> "Фоновая задача завершена"
                                "failed" -> "Фоновая задача завершилась с ошибкой"
                                else -> "Фоновая задача отменена"
                            }
                        }
                        break
                    }
                    delay(2000)
                }
            } catch (error: Exception) {
                if (projectId == taskProjectId) status = error.message ?: "Не удалось обновить статус задачи"
            } finally {
                monitoredTaskIds.remove(taskId)
            }
        }
    }

    fun refreshTasks() {
        runTask {
            tasks = if (localMode) emptyList() else loadBackendTasks(server, projectId)
            tasks.filter { it.status !in listOf("completed", "failed", "cancelled") }
                .forEach { monitorBackendTask(it.id) }
            status = if (localMode) "Переключись на Backend для фоновых задач" else "Список задач обновлён"
        }
    }

    LaunchedEffect(localMode) {
        if (!localMode) {
            runTask {
                if (!backendAuthenticated) {
                    status = "Сначала войди в backend в настройках"
                    return@runTask
                }
                try {
                    api(server, "/api/v1/auth/me", "GET")
                } catch (error: BackendApiException) {
                    if (error.statusCode == 401) {
                        onClearBackendSession()
                        backendAuthenticated = false
                        status = "Сессия истекла. Войди в backend повторно в настройках."
                        return@runTask
                    }
                    throw error
                }
                projects = loadBackendProjects(server)
                if (projects.isEmpty()) {
                    projectId = ""
                    status = "На backend пока нет проектов. Создай первый в разделе «Проекты»."
                } else {
                    val selected = projects.firstOrNull { it.id == projectId } ?: projects.first()
                    projectId = selected.id
                    projectName = selected.name
                    preferences.edit().putString("active_project_id", selected.id).putString("project", selected.name).apply()
                    conversations = loadBackendConversations(server, projectId)
                    tasks = loadBackendTasks(server, projectId)
                    tasks.filter { it.status !in listOf("completed", "failed", "cancelled") }
                        .forEach { monitorBackendTask(it.id) }
                    val active = conversations.firstOrNull { it.id == conversationId } ?: conversations.firstOrNull()
                    conversationId = active?.id.orEmpty()
                    conversationTitle = active?.title ?: "Новый чат"
                    lines.clear()
                    if (active != null) {
                        val data = api(server, "/api/v1/conversations/${active.id}/messages", "GET").optJSONArray("items") ?: JSONArray()
                        for (i in 0 until data.length()) data.optJSONObject(i)?.let {
                            lines.add(ChatLine(it.optString("role"), it.optString("content")))
                        }
                    }
                    if (lines.isEmpty()) lines.add(ChatLine("assistant", "Проект «${selected.name}» открыт. Создай или выбери чат."))
                    memory = loadBackendMemory(server, projectId)
                    status = "Backend подключён"
                }
            }
        } else {
            projects = WorkspaceStore.ensureProjects(preferences)
            if (projects.none { it.id == projectId }) {
                projectId = projects.first().id
                projectName = projects.first().name
                preferences.edit().putString("active_project_id", projectId).apply()
            }
            conversations = WorkspaceStore.loadConversations(preferences, projectId)
            val active = conversations.firstOrNull { it.id == conversationId } ?: conversations.firstOrNull()
            conversationId = active?.id.orEmpty()
            conversationTitle = active?.title ?: "Новый чат"
            lines.clear()
            if (active != null) {
                lines.addAll(WorkspaceStore.loadMessages(preferences, projectId, active.id).map { ChatLine(it.role, it.content) })
            }
            if (lines.isEmpty()) lines.add(ChatLine("assistant", "Локальный проект открыт. Чем займёмся?"))
            memory = WorkspaceStore.loadMemory(preferences, projectId)
        }
    }

    Scaffold(
        containerColor = Navy,
        contentWindowInsets = WindowInsets.safeDrawing,
        topBar = {
            Row(
                Modifier.fillMaxWidth().background(Navy).statusBarsPadding().padding(horizontal = 22.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    Modifier.size(54.dp).background(Accent.copy(alpha = .14f), CircleShape),
                    contentAlignment = Alignment.Center
                ) { Text("L", color = Accent, fontWeight = FontWeight.Black, style = MaterialTheme.typography.titleLarge) }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text("AI LOCMAN", color = MainText, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleLarge)
                    Text(
                        when (screen) {
                            "projects" -> "ПРОЕКТЫ"
                            "history" -> "ИСТОРИЯ ЧАТОВ"
                            "memory" -> "ПАМЯТЬ ПРОЕКТА"
                            "tasks" -> "ФОНОВЫЕ ЗАДАЧИ"
                            "github" -> "GITHUB"
                            "settings" -> "НАСТРОЙКИ"
                            else -> "ТВОЯ AI-СТУДИЯ"
                        },
                        color = Muted, style = MaterialTheme.typography.labelMedium
                    )
                }
                if (screen != "chat") {
                    TextButton(onClick = { screen = "chat" }) { Text("Назад", color = Accent) }
                } else {
                    Box {
                        IconButton(onClick = { navigationExpanded = true }) {
                            Text("☰", color = MainText, style = MaterialTheme.typography.headlineSmall)
                        }
                        DropdownMenu(expanded = navigationExpanded, onDismissRequest = { navigationExpanded = false }) {
                            DropdownMenuItem(text = { Text("Проекты") }, onClick = {
                                navigationExpanded = false
                                runTask {
                                    projects = if (localMode) WorkspaceStore.ensureProjects(preferences) else loadBackendProjects(server)
                                    if (projects.isNotEmpty() && projects.none { it.id == projectId }) {
                                        projectId = projects.first().id
                                        projectName = projects.first().name
                                        preferences.edit().putString("active_project_id", projectId).apply()
                                    }
                                    screen = "projects"
                                }
                            })
                            DropdownMenuItem(text = { Text("История чатов") }, onClick = {
                                navigationExpanded = false
                                runTask {
                                    conversations = if (localMode) WorkspaceStore.loadConversations(preferences, projectId)
                                        else loadBackendConversations(server, projectId)
                                    screen = "history"
                                }
                            })
                            DropdownMenuItem(text = { Text("Память проекта") }, onClick = {
                                navigationExpanded = false
                                runTask {
                                    memory = if (localMode) WorkspaceStore.loadMemory(preferences, projectId)
                                        else loadBackendMemory(server, projectId)
                                    screen = "memory"
                                }
                            })
                            DropdownMenuItem(text = { Text("Фоновые задачи") }, onClick = {
                                navigationExpanded = false
                                runTask {
                                    tasks = if (localMode) emptyList() else loadBackendTasks(server, projectId)
                                    tasks.filter { it.status !in listOf("completed", "failed", "cancelled") }
                                        .forEach { monitorBackendTask(it.id) }
                                    screen = "tasks"
                                }
                            })
                            DropdownMenuItem(text = { Text("GitHub") }, onClick = {
                                navigationExpanded = false
                                runTask {
                                    githubConnected = false
                                    githubInstallations = emptyList()
                                    githubRepositories = emptyList()
                                    selectedGithubRepository = null
                                    if (!localMode) {
                                        val info = api(server, "/api/v1/github/status", "GET")
                                        githubConnected = info.optBoolean("connected")
                                        val installs = info.optJSONArray("installations") ?: JSONArray()
                                        githubInstallations = (0 until installs.length()).mapNotNull { i ->
                                            installs.optJSONObject(i)?.let { item ->
                                                WorkspaceGitHubInstallation(
                                                    item.optString("installation_id"),
                                                    item.optString("account_login"),
                                                    item.optString("account_type")
                                                )
                                            }
                                        }
                                        if (githubConnected) {
                                            githubRepositories = loadGitHubRepositories(server)
                                            val bound = projects.firstOrNull { it.id == projectId }?.githubRepository.orEmpty()
                                            selectedGithubRepository = githubRepositories.firstOrNull { it.fullName == bound }
                                            val boundRepo = selectedGithubRepository
                                            if (boundRepo != null) {
                                                val repo = boundRepo
                                                githubBranches = loadGitHubBranches(server, repo)
                                                selectedGithubBranch = repo.defaultBranch
                                                githubPath = ""
                                                githubFiles = loadGitHubContents(server, repo, "", selectedGithubBranch)
                                            }
                                        }
                                    }
                                    screen = "github"
                                }
                            })
                        }
                    }
                    IconButton(onClick = { screen = "settings" }) {
                        Text("⚙", color = MainText, style = MaterialTheme.typography.headlineSmall)
                    }
                }
            }
        },
        bottomBar = {
            if (screen == "chat") {
                Column(Modifier.fillMaxWidth().background(Navy).navigationBarsPadding().imePadding().padding(horizontal = 18.dp, vertical = 12.dp)) {
                    Row(
                        Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(28.dp)).padding(7.dp),
                        verticalAlignment = Alignment.Bottom
                    ) {
                        OutlinedTextField(
                            value = prompt, onValueChange = { prompt = it },
                            modifier = Modifier.weight(1f),
                            placeholder = { Text("Напиши задачу Лоцману…", color = Muted, style = MaterialTheme.typography.bodyLarge) },
                            minLines = 1, maxLines = 4,
                            shape = RoundedCornerShape(22.dp),
                            textStyle = MaterialTheme.typography.bodyLarge,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = Color.Transparent, unfocusedBorderColor = Color.Transparent,
                                focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent
                            )
                        )
                        Spacer(Modifier.width(4.dp))
                        Button(
                            onClick = {
                                val text = prompt.trim()
                                if (text.isNotEmpty()) {
                                    prompt = ""
                                    if (conversationId.isBlank() && localMode) {
                                        conversationId = UUID.randomUUID().toString()
                                        conversationTitle = text.take(70)
                                        preferences.edit().putString("active_conversation_$projectId", conversationId).apply()
                                    }
                                    lines.add(ChatLine("user", text))
                                    val history = lines.map { it.role to it.text }
                                    if (localMode) {
                                        WorkspaceStore.saveConversation(
                                            preferences, projectId, conversationId, text.take(70),
                                            lines.map { WorkspaceMessage(it.role, it.text) }
                                        )
                                    }
                                    runTask {
                                        status = "Отправляю запрос…"
                                        if (!localMode && conversationId.isBlank()) {
                                            val created = api(server, "/api/v1/projects/$projectId/conversations", "POST",
                                                JSONObject().put("title", text.take(70)))
                                            conversationId = created.getString("id")
                                            conversationTitle = created.optString("title", text.take(70))
                                            preferences.edit().putString("active_conversation_$projectId", conversationId).apply()
                                        }
                                        var streamingMessageIndex = -1
                                        val answer = if (localMode) {
                                            streamingMessageIndex = lines.size
                                            lines.add(ChatLine("assistant", ""))
                                            try {
                                                openRouterChat(
                                                    apiKey, model, history, projects.firstOrNull { it.id == projectId }?.name ?: projectName,
                                                    memory
                                                ) { chunk ->
                                                    val current = lines.getOrNull(streamingMessageIndex)?.text.orEmpty()
                                                    lines[streamingMessageIndex] = ChatLine("assistant", current + chunk)
                                                }
                                            } catch (error: Exception) {
                                                if (streamingMessageIndex == lines.lastIndex) lines.removeAt(streamingMessageIndex)
                                                throw error
                                            }
                                        } else {
                                            require(projectId.isNotBlank()) { "Сначала выбери или создай проект" }
                                            val queued = api(server, "/api/v1/projects/$projectId/tasks", "POST",
                                                JSONObject().put("conversationId", conversationId).put("model", model).put("prompt", text)
                                            )
                                            val task = workspaceTaskFromJson(queued)
                                            tasks = (tasks.filterNot { it.id == task.id } + task)
                                            monitorBackendTask(task.id)
                                            status = "Задача добавлена в очередь. Она продолжится на сервере."
                                            return@runTask
                                        }
                                        if (streamingMessageIndex >= 0) {
                                            lines[streamingMessageIndex] = ChatLine("assistant", answer)
                                        } else {
                                            lines.add(ChatLine("assistant", answer))
                                        }
                                        val isFirstMessage = conversationTitle == "Новый чат"
                                        conversationTitle = if (isFirstMessage) text.take(70) else conversationTitle
                                        if (!localMode && isFirstMessage) {
                                            api(server, "/api/v1/conversations/$conversationId", "PATCH",
                                                JSONObject().put("title", conversationTitle))
                                        }
                                        if (localMode) {
                                            WorkspaceStore.saveConversation(
                                                preferences, projectId, conversationId, conversationTitle,
                                                lines.map { WorkspaceMessage(it.role, it.text) }
                                            )
                                            conversations = WorkspaceStore.loadConversations(preferences, projectId)
                                        } else {
                                            conversations = loadBackendConversations(server, projectId)
                                        }
                                        status = "Ответ получен"
                                    }
                                }
                            },
                            enabled = !busy && prompt.isNotBlank() && projectId.isNotBlank() && (if (localMode) apiKey.isNotBlank() else true),
                            modifier = Modifier.size(58.dp),
                            contentPadding = PaddingValues(0.dp),
                            colors = ButtonDefaults.buttonColors(disabledContainerColor = Panel2, disabledContentColor = Muted),
                            shape = RoundedCornerShape(20.dp)
                        ) { Text(if (busy) "…" else "➤", style = MaterialTheme.typography.titleMedium) }
                    }
                }
            }
        }
    ) { padding ->
        when (screen) {
            "settings" -> SettingsScreen(
                modifier = Modifier.fillMaxSize().padding(padding),
                localMode = localMode, onLocalMode = { localMode = it },
                apiKey = apiKey, onApiKey = { apiKey = it },
                backendAuthenticated = backendAuthenticated,
                backendPassword = backendPassword,
                onBackendPassword = { backendPassword = it },
                onLoginBackend = {
                    runTask {
                        status = "Выполняю вход на backend…"
                        val result = api(server, "/api/v1/auth/login", "POST", JSONObject().put("password", backendPassword))
                        onSaveBackendSession(result.getString("token"))
                        backendAuthenticated = true
                        backendPassword = ""
                        projects = loadBackendProjects(server)
                        val selected = projects.firstOrNull()
                        if (selected != null) {
                            projectId = selected.id
                            projectName = selected.name
                            conversations = loadBackendConversations(server, selected.id)
                            tasks = loadBackendTasks(server, selected.id)
                        }
                        status = "Вход выполнен. Сессия сохранена в защищённом хранилище Android."
                    }
                },
                onLogoutBackend = {
                    runTask {
                        runCatching { api(server, "/api/v1/auth/logout", "POST") }
                        onClearBackendSession()
                        backendAuthenticated = false
                        status = "Сессия завершена"
                    }
                },
                server = server, onServer = { server = it },
                project = projectName, onProject = { projectName = it },
                model = model, models = models,
                onLoadModels = {
                    runTask {
                        status = "Загружаю каталог OpenRouter…"
                        models = fetchOpenRouterModels(apiKey)
                        status = "Загружено моделей: ${models.size}"
                        showModelPicker = true
                    }
                },
                onCreateProject = {
                    runTask {
                        val result = api(server, "/api/v1/projects", "POST",
                            JSONObject().put("name", projectName).put("description", "Проект AI Locman").put("model", model))
                        projectId = result.getString("id")
                        status = "Проект создан на backend"
                    }
                },
                busy = busy,
                status = status,
                onSave = {
                    onSaveSettings(server.trim().trimEnd('/'), model, localMode, projectName)
                    onSaveKey(apiKey.trim())
                    status = "Настройки сохранены"
                    screen = "chat"
                }
            )
            "projects" -> ProjectsScreen(
                projects = projects, activeProjectId = projectId,
                onSelect = { selected ->
                    runTask {
                        projectId = selected.id
                        projectName = selected.name
                        model = if (localMode) {
                            preferences.getString("project_model_${selected.id}", selected.model) ?: selected.model
                        } else selected.model
                        preferences.edit().putString("active_project_id", selected.id).putString("project", selected.name).putString("model", model).apply()
                        conversations = if (localMode) WorkspaceStore.loadConversations(preferences, selected.id)
                            else loadBackendConversations(server, selected.id)
                        tasks = if (localMode) emptyList() else loadBackendTasks(server, selected.id)
                        tasks.filter { it.status !in listOf("completed", "failed", "cancelled") }
                            .forEach { monitorBackendTask(it.id) }
                        val chosen = conversations.firstOrNull()
                        conversationId = chosen?.id.orEmpty()
                        conversationTitle = chosen?.title ?: "Новый чат"
                        lines.clear()
                        if (conversationId.isNotBlank()) {
                            if (localMode) {
                                lines.addAll(WorkspaceStore.loadMessages(preferences, projectId, conversationId).map { ChatLine(it.role, it.content) })
                            } else {
                                val data = api(server, "/api/v1/conversations/$conversationId/messages", "GET").optJSONArray("items") ?: JSONArray()
                                for (i in 0 until data.length()) data.optJSONObject(i)?.let { lines.add(ChatLine(it.optString("role"), it.optString("content"))) }
                            }
                        }
                        if (lines.isEmpty()) lines.add(ChatLine("assistant", "Проект «${selected.name}» открыт. Чем займёмся?"))
                        memory = if (localMode) WorkspaceStore.loadMemory(preferences, projectId) else loadBackendMemory(server, projectId)
                        screen = "chat"
                    }
                },
                onCreate = { name ->
                    runTask {
                        val created = if (localMode) {
                            val item = WorkspaceProject(UUID.randomUUID().toString(), name, model = model)
                            projects = projects + item
                            WorkspaceStore.saveProjects(preferences, projects)
                            item
                        } else {
                            val json = api(server, "/api/v1/projects", "POST", JSONObject().put("name", name).put("description", "Проект AI Locman").put("model", model))
                            WorkspaceProject(json.getString("id"), json.optString("name", name), json.optString("description"), json.optString("model", model))
                                .also { projects = loadBackendProjects(server) }
                        }
                        projectId = created.id
                        projectName = created.name
                        preferences.edit().putString("active_project_id", created.id).putString("project", created.name).apply()
                        conversations = emptyList()
                        conversationId = ""
                        conversationTitle = "Новый чат"
                        lines.clear()
                        lines.add(ChatLine("assistant", "Проект «${created.name}» создан. Создай новый чат."))
                        memory = WorkspaceMemory()
                        screen = "chat"
                    }
                }
            )
            "history" -> HistoryScreen(
                conversations = conversations, activeConversationId = conversationId,
                onOpen = { item ->
                    runTask {
                        conversationId = item.id
                        conversationTitle = item.title
                        preferences.edit().putString("active_conversation_$projectId", item.id).apply()
                        lines.clear()
                        if (localMode) {
                            lines.addAll(WorkspaceStore.loadMessages(preferences, projectId, item.id).map { ChatLine(it.role, it.content) })
                        } else {
                            val data = api(server, "/api/v1/conversations/${item.id}/messages", "GET").optJSONArray("items") ?: JSONArray()
                            for (i in 0 until data.length()) data.optJSONObject(i)?.let { lines.add(ChatLine(it.optString("role"), it.optString("content"))) }
                        }
                        if (lines.isEmpty()) lines.add(ChatLine("assistant", "Новый диалог. Чем займёмся?"))
                        screen = "chat"
                    }
                },
                onCreate = {
                    runTask {
                        val created = if (localMode) {
                            WorkspaceConversation(UUID.randomUUID().toString(), "Новый чат")
                        } else {
                            val json = api(server, "/api/v1/projects/$projectId/conversations", "POST", JSONObject().put("title", "Новый чат"))
                            WorkspaceConversation(json.getString("id"), json.optString("title", "Новый чат"))
                        }
                        conversationId = created.id
                        conversationTitle = created.title
                        preferences.edit().putString("active_conversation_$projectId", created.id).apply()
                        lines.clear()
                        if (localMode) WorkspaceStore.saveConversation(preferences, projectId, created.id, created.title, emptyList())
                        conversations = if (localMode) WorkspaceStore.loadConversations(preferences, projectId) else loadBackendConversations(server, projectId)
                        screen = "chat"
                    }
                },
                onRename = { item -> editingConversation = item; renameValue = item.title },
                onDelete = { item -> deletingConversation = item }
            )
            "memory" -> MemoryScreen(initial = memory, onSave = { updated ->
                runTask {
                    if (localMode) {
                        WorkspaceStore.saveMemory(preferences, projectId, updated)
                    } else {
                        listOf(
                            "architecture" to updated.architecture,
                            "decisions" to updated.decisions,
                            "knowledge" to updated.knowledge
                        ).forEach { (section, content) ->
                            api(server, "/api/v1/projects/$projectId/memory", "PUT",
                                JSONObject().put("section", section).put("content", content))
                        }
                    }
                    memory = updated
                    status = "Память проекта сохранена"
                    screen = "chat"
                }
            })
            "tasks" -> TasksScreen(
                tasks = tasks,
                backendAvailable = !localMode,
                busy = busy,
                onRefresh = { refreshTasks() },
                onCancel = { task ->
                    runTask {
                        api(server, "/api/v1/tasks/${task.id}/cancel", "POST")
                        tasks = loadBackendTasks(server, projectId)
                        status = "Отмена задачи запрошена"
                    }
                },
                onOpenResult = { task ->
                    runTask {
                        val id = task.conversationId
                        require(id.isNotBlank()) { "У задачи ещё нет связанного диалога" }
                        conversationId = id
                        conversationTitle = conversations.firstOrNull { it.id == id }?.title ?: task.prompt.take(70)
                        preferences.edit().putString("active_conversation_$projectId", id).apply()
                        val data = api(server, "/api/v1/conversations/$id/messages", "GET").optJSONArray("items") ?: JSONArray()
                        lines.clear()
                        for (i in 0 until data.length()) data.optJSONObject(i)?.let {
                            lines.add(ChatLine(it.optString("role"), it.optString("content")))
                        }
                        if (lines.isEmpty() && task.result.isNotBlank()) lines.add(ChatLine("assistant", task.result))
                        screen = "chat"
                    }
                }
            )
            "github" -> GitHubScreen(
                backendAvailable = !localMode,
                server = server,
                connected = githubConnected,
                installations = githubInstallations,
                repositories = githubRepositories,
                selectedRepository = selectedGithubRepository,
                branches = githubBranches,
                selectedBranch = selectedGithubBranch,
                currentPath = githubPath,
                files = githubFiles,
                selectedFilePath = githubSelectedFilePath,
                selectedFileContent = githubFileContent,
                commits = githubCommits,
                pulls = githubPulls,
                workflowRuns = githubWorkflowRuns,
                selectedSection = githubSection,
                diffText = githubDiff,
                busy = busy,
                onRefresh = {
                    runTask {
                        val info = api(server, "/api/v1/github/status", "GET")
                        githubConnected = info.optBoolean("connected")
                        val installs = info.optJSONArray("installations") ?: JSONArray()
                        githubInstallations = (0 until installs.length()).mapNotNull { i ->
                            installs.optJSONObject(i)?.let { item ->
                                WorkspaceGitHubInstallation(item.optString("installation_id"), item.optString("account_login"), item.optString("account_type"))
                            }
                        }
                        githubRepositories = if (githubConnected) loadGitHubRepositories(server) else emptyList()
                        val bound = projects.firstOrNull { it.id == projectId }?.githubRepository.orEmpty()
                        selectedGithubRepository = githubRepositories.firstOrNull { it.fullName == bound }
                        if (selectedGithubRepository != null) {
                            val repo = selectedGithubRepository!!
                            githubBranches = loadGitHubBranches(server, repo)
                            selectedGithubBranch = repo.defaultBranch
                            githubPath = ""
                            githubFiles = loadGitHubContents(server, repo, "", selectedGithubBranch)
                        }
                        status = "GitHub обновлён"
                    }
                },
                onSelectRepository = { repo ->
                    runTask {
                        selectedGithubRepository = repo
                        githubSection = "files"
                        githubCommits = emptyList()
                        githubPulls = emptyList()
                        githubWorkflowRuns = emptyList()
                        githubDiff = ""
                        githubPath = ""
                        githubSelectedFilePath = ""
                        githubFileContent = ""
                        githubBranches = loadGitHubBranches(server, repo)
                        selectedGithubBranch = repo.defaultBranch
                        githubFiles = loadGitHubContents(server, repo, "", selectedGithubBranch)
                        val updated = projects.map { item ->
                            if (item.id == projectId) item.copy(githubRepository = repo.fullName) else item
                        }
                        projects = updated
                        if (localMode) {
                            WorkspaceStore.saveProjects(preferences, updated)
                        } else {
                            api(server, "/api/v1/projects/$projectId", "PATCH", JSONObject().put("githubRepository", repo.fullName))
                        }
                        status = "Репозиторий привязан к проекту"
                    }
                },
                onBackToRepositories = {
                    selectedGithubRepository = null
                    githubSelectedFilePath = ""
                    githubFileContent = ""
                },
                onSelectBranch = { branch ->
                    val repo = selectedGithubRepository
                    if (repo != null) runTask {
                        selectedGithubBranch = branch
                        githubPath = ""
                        githubSelectedFilePath = ""
                        githubFileContent = ""
                        githubFiles = loadGitHubContents(server, repo, "", branch)
                    }
                },
                onNavigateDirectory = { directory ->
                    val repo = selectedGithubRepository
                    if (repo != null) runTask {
                        githubPath = directory
                        githubSelectedFilePath = ""
                        githubFileContent = ""
                        githubFiles = loadGitHubContents(server, repo, directory, selectedGithubBranch)
                    }
                },
                onOpenFile = { item ->
                    val repo = selectedGithubRepository
                    if (repo != null) runTask {
                        val raw = githubApiRaw(server, githubContentsRoute(repo, item.path, selectedGithubBranch))
                        val json = JSONObject(raw)
                        require(json.optString("encoding") == "base64") { "GitHub не вернул текстовый файл в Base64" }
                        val encoded = json.optString("content").replace("\n", "").replace("\r", "")
                        require(encoded.length <= 1_400_000) { "Файл больше 1 МБ — предпросмотр отключён" }
                        val bytes = Base64.decode(encoded, Base64.DEFAULT)
                        require(bytes.size <= 1_000_000) { "Файл больше 1 МБ — предпросмотр отключён" }
                        githubSelectedFilePath = item.path
                        githubFileContent = String(bytes, Charsets.UTF_8)
                    }
                },
                onCloseFile = {
                    githubSelectedFilePath = ""
                    githubFileContent = ""
                },
                onUpPath = {
                    val repo = selectedGithubRepository
                    if (repo != null) runTask {
                        githubPath = githubPath.substringBeforeLast("/", "")
                        githubFiles = loadGitHubContents(server, repo, githubPath, selectedGithubBranch)
                    }
                },
                onSectionChange = { section ->
                    githubSection = section
                    val repo = selectedGithubRepository
                    if (repo != null) runTask {
                        when (section) {
                            "commits" -> githubCommits = loadGitHubCommits(server, repo)
                            "pulls" -> githubPulls = loadGitHubPulls(server, repo)
                            "actions" -> githubWorkflowRuns = loadGitHubWorkflowRuns(server, repo)
                            "diff" -> githubDiff = ""
                        }
                    }
                },
                onCompare = { base, head ->
                    val repo = selectedGithubRepository
                    if (repo != null) runTask {
                        githubDiff = loadGitHubDiff(server, repo, base, head)
                    }
                }
            )
            else -> {
            Column(Modifier.fillMaxSize().padding(padding)) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Surface(color = Panel2, shape = RoundedCornerShape(50)) {
                        Row(Modifier.padding(horizontal = 14.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(7.dp).background(if (localMode) Accent else Blue, CircleShape))
                            Spacer(Modifier.width(7.dp))
                            Text(if (localMode) "LOCAL AI" else "BACKEND", color = MainText, style = MaterialTheme.typography.labelMedium)
                        }
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(model.substringAfterLast('/'), color = Muted, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                }
                HorizontalDivider(color = Color.White.copy(alpha = .07f))
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 18.dp, vertical = 20.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    items(lines) { line ->
                        val isUser = line.role == "user"
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start) {
                            Surface(
                                color = if (isUser) Color(0xFF203B5A) else Panel,
                                shape = RoundedCornerShape(
                                    topStart = 18.dp, topEnd = 18.dp,
                                    bottomStart = if (isUser) 18.dp else 5.dp,
                                    bottomEnd = if (isUser) 5.dp else 18.dp
                                ),
                                modifier = Modifier.fillMaxWidth(if (isUser) .88f else .92f)
                            ) {
                                Column(Modifier.padding(horizontal = 18.dp, vertical = 15.dp)) {
                                    Text(if (isUser) "ВЫ" else "ЛОЦМАН", color = if (isUser) Blue else Accent,
                                        style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                                    Spacer(Modifier.height(5.dp))
                                    Text(line.text, color = MainText, style = MaterialTheme.typography.bodyLarge)
                                }
                            }
                        }
                    }
                    if (busy) item {
                        Text("Лоцман думает…", color = Accent, style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(start = 8.dp))
                    }
                }
                if (status.isNotBlank()) {
                    Text(status, color = Muted, style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 8.dp), maxLines = 1)
                }
            }
            }
        }
    }

    if (editingConversation != null) {
        AlertDialog(
            onDismissRequest = { editingConversation = null },
            title = { Text("Переименовать чат") },
            text = {
                OutlinedTextField(value = renameValue, onValueChange = { renameValue = it }, singleLine = true)
            },
            confirmButton = {
                TextButton(onClick = {
                    val item = editingConversation
                    val title = renameValue.trim()
                    if (item != null && title.isNotBlank()) {
                        runTask {
                            if (localMode) {
                                WorkspaceStore.renameConversation(preferences, projectId, item.id, title)
                                conversations = WorkspaceStore.loadConversations(preferences, projectId)
                            } else {
                                api(server, "/api/v1/conversations/${item.id}", "PATCH", JSONObject().put("title", title))
                                conversations = loadBackendConversations(server, projectId)
                            }
                            if (conversationId == item.id) conversationTitle = title
                            editingConversation = null
                        }
                    }
                }) { Text("Сохранить") }
            },
            dismissButton = { TextButton(onClick = { editingConversation = null }) { Text("Отмена") } }
        )
    }
    if (deletingConversation != null) {
        AlertDialog(
            onDismissRequest = { deletingConversation = null },
            title = { Text("Удалить переписку?") },
            text = { Text("Это удалит сообщения выбранного чата.") },
            confirmButton = {
                TextButton(onClick = {
                    val item = deletingConversation
                    if (item != null) runTask {
                        if (localMode) {
                            WorkspaceStore.deleteConversation(preferences, projectId, item.id)
                            conversations = WorkspaceStore.loadConversations(preferences, projectId)
                        } else {
                            api(server, "/api/v1/conversations/${item.id}", "DELETE")
                            conversations = loadBackendConversations(server, projectId)
                        }
                        if (conversationId == item.id) {
                            conversationId = ""
                            preferences.edit().remove("active_conversation_$projectId").apply()
                            conversationTitle = "Новый чат"
                            lines.clear()
                            lines.add(ChatLine("assistant", "Чат удалён. Создай новую переписку."))
                        }
                        deletingConversation = null
                    }
                }) { Text("Удалить") }
            },
            dismissButton = { TextButton(onClick = { deletingConversation = null }) { Text("Отмена") } }
        )
    }

    if (showModelPicker) {
        val filtered = models.filter { it.id.contains(modelSearch, true) || it.name.contains(modelSearch, true) }
        AlertDialog(
            onDismissRequest = { showModelPicker = false; modelSearch = "" },
            containerColor = Panel,
            title = { Text("Выбрать модель", color = MainText) },
            text = {
                Column(Modifier.fillMaxWidth().heightIn(max = 520.dp)) {
                    OutlinedTextField(
                        value = modelSearch, onValueChange = { modelSearch = it },
                        modifier = Modifier.fillMaxWidth(), singleLine = true,
                        placeholder = { Text("Поиск по названию или ID") }
                    )
                    Spacer(Modifier.height(8.dp))
                    if (filtered.isEmpty()) {
                        Text("Модели не найдены. Обнови список в настройках.", color = Muted)
                    } else {
                        LazyColumn(Modifier.weight(1f)) {
                            items(filtered.take(300)) { item ->
                                Column(
                                    Modifier.fillMaxWidth().clickable {
                                        model = item.id
                                        val updatedProject = projects.firstOrNull { it.id == projectId }?.copy(model = item.id)
                                        if (updatedProject != null) {
                                            projects = projects.map { if (it.id == projectId) updatedProject else it }
                                            if (localMode) {
                                                WorkspaceStore.saveProjects(preferences, projects)
                                            } else {
                                                scope.launch {
                                                    runCatching {
                                                        api(server, "/api/v1/projects/$projectId", "PATCH", JSONObject().put("model", item.id))
                                                    }.onFailure { status = it.message ?: "Не удалось сохранить модель проекта" }
                                                }
                                            }
                                        }
                                        preferences.edit().putString("project_model_$projectId", item.id).putString("model", item.id).apply()
                                        modelSearch = ""
                                        showModelPicker = false
                                    }.padding(vertical = 10.dp)
                                ) {
                                    Text(item.name, color = MainText, fontWeight = FontWeight.SemiBold)
                                    Text(item.id, color = Accent, style = MaterialTheme.typography.labelSmall)
                                    if (item.context > 0) Text("Контекст: ${item.context}", color = Muted, style = MaterialTheme.typography.labelSmall)
                                }
                                HorizontalDivider(color = Color.White.copy(alpha = .06f))
                            }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showModelPicker = false; modelSearch = "" }) { Text("Закрыть") } }
        )
    }
}

@Composable
private fun SettingsScreen(
    modifier: Modifier,
    localMode: Boolean, onLocalMode: (Boolean) -> Unit,
    apiKey: String, onApiKey: (String) -> Unit,
    backendAuthenticated: Boolean, backendPassword: String, onBackendPassword: (String) -> Unit,
    onLoginBackend: () -> Unit, onLogoutBackend: () -> Unit,
    server: String, onServer: (String) -> Unit,
    project: String, onProject: (String) -> Unit,
    model: String, models: List<ModelInfo>,
    onLoadModels: () -> Unit, onCreateProject: () -> Unit,
    busy: Boolean, status: String, onSave: () -> Unit
) {
    Column(modifier.verticalScroll(rememberScrollState()).padding(horizontal = 18.dp, vertical = 12.dp)) {
        Text("Настройки", color = MainText, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text("Подключение и параметры Лоцмана", color = Muted, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(20.dp))
        SettingsCard("РЕЖИМ РАБОТЫ") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Локальный AI", color = MainText, fontWeight = FontWeight.SemiBold)
                    Text("Телефон подключается напрямую к OpenRouter", color = Muted, style = MaterialTheme.typography.bodySmall)
                }
                Switch(checked = localMode, onCheckedChange = onLocalMode)
            }
            if (localMode) {
                OutlinedTextField(
                    value = apiKey, onValueChange = onApiKey, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Ключ OpenRouter") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password)
                )
                Text("Ключ сохраняется в зашифрованном хранилище Android.", color = Muted, style = MaterialTheme.typography.bodySmall)
            } else {
                OutlinedTextField(value = server, onValueChange = onServer, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Адрес backend") }, singleLine = true)
                Text(if (backendAuthenticated) "Серверная сессия активна" else "Для доступа к серверу требуется пароль",
                    color = if (backendAuthenticated) Accent else Muted, style = MaterialTheme.typography.bodySmall)
                if (backendAuthenticated) {
                    OutlinedButton(onClick = onLogoutBackend, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                        Text("Выйти из backend")
                    }
                } else {
                    OutlinedTextField(
                        value = backendPassword, onValueChange = onBackendPassword, modifier = Modifier.fillMaxWidth(),
                        label = { Text("Пароль доступа к backend") }, singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password)
                    )
                    Button(onClick = onLoginBackend, enabled = !busy && backendPassword.isNotBlank(),
                        modifier = Modifier.fillMaxWidth()) { Text("Войти на backend") }
                }
                OutlinedTextField(value = project, onValueChange = onProject, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Название проекта") }, singleLine = true)
                OutlinedButton(onClick = onCreateProject, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                    Text("Создать проект на сервере")
                }
            }
        }
        Spacer(Modifier.height(14.dp))
        SettingsCard("МОДЕЛЬ ИИ") {
            Text("Текущая модель", color = Muted, style = MaterialTheme.typography.labelMedium)
            Text(model, color = Accent, fontWeight = FontWeight.SemiBold)
            Button(onClick = onLoadModels, enabled = !busy && (apiKey.isNotBlank() || !localMode),
                modifier = Modifier.fillMaxWidth()) {
                Text(if (busy) "Загружаю…" else "Загрузить модели OpenRouter")
            }
            if (models.isNotEmpty()) Text("В каталоге загружено: ${models.size}", color = Muted, style = MaterialTheme.typography.bodySmall)
            Text("Список загружается из OpenRouter API. Можно искать по названию и ID.", color = Muted, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(14.dp))
        SettingsCard("О ПРИЛОЖЕНИИ") {
            Text("AI Locman · тестовая версия", color = MainText, fontWeight = FontWeight.SemiBold)
            Text("Сейчас доступен чат с моделями OpenRouter. Инструменты разработки и сборка проектов будут подключаться следующими этапами.", color = Muted, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(12.dp))
        Text(status, color = Muted, style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(14.dp))
        Button(onClick = onSave, modifier = Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(16.dp)) {
            Text("Сохранить настройки", fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun SettingsCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = Panel),
        shape = RoundedCornerShape(20.dp)
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, color = Accent, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
            content()
        }
    }
}




private fun workspaceTaskFromJson(json: JSONObject): WorkspaceTask = WorkspaceTask(
    id = json.optString("id"),
    prompt = json.optString("prompt"),
    model = json.optString("model"),
    status = json.optString("status", "queued"),
    result = json.optString("result"),
    error = json.optString("error"),
    conversationId = json.optString("conversation_id")
)

private suspend fun loadBackendTasks(server: String, projectId: String): List<WorkspaceTask> {
    if (projectId.isBlank()) return emptyList()
    val data = api(server, "/api/v1/projects/$projectId/tasks", "GET").optJSONArray("items") ?: JSONArray()
    return (0 until data.length()).mapNotNull { i ->
        data.optJSONObject(i)?.let { item ->
            workspaceTaskFromJson(item).takeIf { it.id.isNotBlank() }
        }
    }
}

private suspend fun loadBackendTask(server: String, taskId: String): WorkspaceTask =
    workspaceTaskFromJson(api(server, "/api/v1/tasks/$taskId", "GET"))



private suspend fun loadGitHubCommits(server: String, repo: WorkspaceGitHubRepository): List<WorkspaceGitHubCommit> {
    val owner = repo.fullName.substringBefore("/")
    val name = repo.fullName.substringAfter("/")
    val array = JSONArray(githubApiRaw(server, "/api/v1/github/repositories/$owner/$name/commits"))
    return (0 until array.length()).mapNotNull { i ->
        array.optJSONObject(i)?.let { item ->
            val commit = item.optJSONObject("commit")
            val author = commit?.optJSONObject("author")
            val sha = item.optString("sha")
            if (sha.isBlank()) null else WorkspaceGitHubCommit(
                sha = sha,
                message = commit?.optString("message").orEmpty().lineSequence().firstOrNull().orEmpty(),
                author = author?.optString("name").orEmpty(),
                createdAt = author?.optString("date").orEmpty(),
                htmlUrl = item.optString("html_url")
            )
        }
    }
}

private suspend fun loadGitHubPulls(server: String, repo: WorkspaceGitHubRepository): List<WorkspaceGitHubPull> {
    val owner = repo.fullName.substringBefore("/")
    val name = repo.fullName.substringAfter("/")
    val array = JSONArray(githubApiRaw(server, "/api/v1/github/repositories/$owner/$name/pulls"))
    return (0 until array.length()).mapNotNull { i ->
        array.optJSONObject(i)?.let { item ->
            val number = item.optInt("number")
            if (number <= 0) null else WorkspaceGitHubPull(
                id = item.opt("id")?.toString() ?: number.toString(),
                number = number,
                title = item.optString("title"),
                state = item.optString("state"),
                head = item.optJSONObject("head")?.optString("ref").orEmpty(),
                base = item.optJSONObject("base")?.optString("ref").orEmpty(),
                author = item.optJSONObject("user")?.optString("login").orEmpty(),
                htmlUrl = item.optString("html_url")
            )
        }
    }
}

private suspend fun loadGitHubWorkflowRuns(server: String, repo: WorkspaceGitHubRepository): List<WorkspaceGitHubRun> {
    val owner = repo.fullName.substringBefore("/")
    val name = repo.fullName.substringAfter("/")
    val json = JSONObject(githubApiRaw(server, "/api/v1/github/repositories/$owner/$name/actions"))
    val array = json.optJSONArray("workflow_runs") ?: JSONArray()
    return (0 until array.length()).mapNotNull { i ->
        array.optJSONObject(i)?.let { item ->
            val id = item.opt("id")?.toString().orEmpty()
            if (id.isBlank()) null else WorkspaceGitHubRun(
                id = id,
                name = item.optString("name").ifBlank { item.optString("display_title") },
                status = item.optString("status"),
                conclusion = item.optString("conclusion"),
                branch = item.optString("head_branch"),
                createdAt = item.optString("created_at"),
                htmlUrl = item.optString("html_url")
            )
        }
    }
}

private suspend fun loadGitHubDiff(
    server: String, repo: WorkspaceGitHubRepository, base: String, head: String
): String {
    require(base.isNotBlank() && head.isNotBlank()) { "Выбери обе ветки для сравнения" }
    val owner = repo.fullName.substringBefore("/")
    val name = repo.fullName.substringAfter("/")
    val query = "?base=" + java.net.URLEncoder.encode(base, "UTF-8") +
        "&head=" + java.net.URLEncoder.encode(head, "UTF-8")
    return githubApiRaw(server, "/api/v1/github/repositories/$owner/$name/compare$query")
}

private fun githubContentsRoute(repo: WorkspaceGitHubRepository, path: String, branch: String): String {
    val owner = repo.fullName.substringBefore("/")
    val name = repo.fullName.substringAfter("/")
    val params = buildList {
        if (path.isNotBlank()) add("path=" + java.net.URLEncoder.encode(path, "UTF-8"))
        if (branch.isNotBlank()) add("ref=" + java.net.URLEncoder.encode(branch, "UTF-8"))
    }.joinToString("&")
    return "/api/v1/github/repositories/$owner/$name/contents" + if (params.isBlank()) "" else "?$params"
}

private suspend fun githubApiRaw(server: String, path: String): String = withContext(Dispatchers.IO) {
    val root = server.trim().trimEnd('/')
    require(root.startsWith("http://") || root.startsWith("https://")) { "Адрес backend должен начинаться с http:// или https://" }
    val connection = (URL(root + path).openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        connectTimeout = 15_000
        readTimeout = 60_000
        setRequestProperty("Accept", "application/json")
        BackendSession.token()?.let { setRequestProperty("Authorization", "Bearer $it") }
    }
    try {
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        val raw = stream?.bufferedReader()?.use { it.readText() } ?: ""
        if (code !in 200..299) {
            val detail = runCatching { JSONObject(raw).optString("error") }.getOrNull()
            throw IllegalStateException(detail?.takeIf { it.isNotBlank() } ?: "Backend HTTP $code")
        }
        raw
    } finally { connection.disconnect() }
}

private suspend fun loadGitHubRepositories(server: String): List<WorkspaceGitHubRepository> {
    val data = api(server, "/api/v1/github/repositories", "GET").optJSONArray("items") ?: JSONArray()
    return (0 until data.length()).mapNotNull { i ->
        data.optJSONObject(i)?.let { item ->
            val fullName = item.optString("full_name")
            if (fullName.isBlank()) null else WorkspaceGitHubRepository(
                id = item.opt("id")?.toString() ?: fullName,
                fullName = fullName,
                isPrivate = item.optBoolean("private"),
                description = item.optString("description"),
                defaultBranch = item.optString("default_branch", "main"),
                htmlUrl = item.optString("html_url")
            )
        }
    }.sortedBy { it.fullName.lowercase() }
}

private suspend fun loadGitHubBranches(server: String, repo: WorkspaceGitHubRepository): List<WorkspaceGitHubBranch> {
    val owner = repo.fullName.substringBefore("/")
    val name = repo.fullName.substringAfter("/")
    val raw = githubApiRaw(server, "/api/v1/github/repositories/$owner/$name/branches")
    val array = JSONArray(raw)
    return (0 until array.length()).mapNotNull { i ->
        array.optJSONObject(i)?.let { item ->
            val branchName = item.optString("name")
            if (branchName.isBlank()) null else WorkspaceGitHubBranch(branchName, item.optBoolean("protected"))
        }
    }
}

private suspend fun loadGitHubContents(
    server: String, repo: WorkspaceGitHubRepository, path: String, branch: String
): List<WorkspaceGitHubContent> {
    val raw = githubApiRaw(server, githubContentsRoute(repo, path, branch))
    val array = JSONArray(raw)
    return (0 until array.length()).mapNotNull { i ->
        array.optJSONObject(i)?.let { item ->
            val name = item.optString("name")
            val itemPath = item.optString("path")
            if (itemPath.isBlank()) null else WorkspaceGitHubContent(
                name = name,
                path = itemPath,
                type = item.optString("type"),
                size = item.optLong("size")
            )
        }
    }.sortedWith(compareBy<WorkspaceGitHubContent> { it.type != "dir" }.thenBy { it.name.lowercase() })
}

private suspend fun loadBackendProjects(server: String): List<WorkspaceProject> {
    val data = api(server, "/api/v1/projects", "GET").optJSONArray("items") ?: JSONArray()
    return (0 until data.length()).mapNotNull { i ->
        data.optJSONObject(i)?.let { item ->
            val id = item.optString("id")
            if (id.isBlank()) null else WorkspaceProject(id, item.optString("name", "Проект"), item.optString("description"), item.optString("model", "openrouter/auto"), item.optString("github_repository"))
        }
    }
}

private suspend fun loadBackendConversations(server: String, projectId: String): List<WorkspaceConversation> {
    if (projectId.isBlank()) return emptyList()
    val data = api(server, "/api/v1/projects/$projectId/conversations", "GET").optJSONArray("items") ?: JSONArray()
    return (0 until data.length()).mapNotNull { i ->
        data.optJSONObject(i)?.let { item ->
            val id = item.optString("id")
            if (id.isBlank()) null else WorkspaceConversation(
                id, item.optString("title", "Новый чат"), item.optString("last_message")
            )
        }
    }
}

private suspend fun loadBackendMemory(server: String, projectId: String): WorkspaceMemory {
    val data = api(server, "/api/v1/projects/$projectId/memory", "GET").optJSONArray("items") ?: JSONArray()
    fun value(section: String): String = (0 until data.length()).mapNotNull { data.optJSONObject(it) }
        .firstOrNull { it.optString("section") == section }?.optString("content").orEmpty()
    return WorkspaceMemory(value("architecture"), value("decisions"), value("knowledge"))
}

private suspend fun fetchOpenRouterModels(key: String): List<ModelInfo> = withContext(Dispatchers.IO) {
    val connection = (URL("https://openrouter.ai/api/v1/models").openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        connectTimeout = 15_000
        readTimeout = 45_000
        setRequestProperty("Accept", "application/json")
        if (key.isNotBlank()) setRequestProperty("Authorization", "Bearer $key")
    }
    try {
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        val raw = stream?.bufferedReader()?.use { it.readText() } ?: "{}"
        val json = JSONObject(raw)
        if (code !in 200..299) throw IllegalStateException(json.optJSONObject("error")?.optString("message") ?: "OpenRouter HTTP $code")
        val data = json.optJSONArray("data") ?: JSONArray()
        buildList {
            for (i in 0 until data.length()) {
                val item = data.optJSONObject(i) ?: continue
                val id = item.optString("id")
                if (id.isNotBlank()) add(ModelInfo(
                    id = id,
                    name = item.optString("name").takeIf { it.isNotBlank() } ?: id,
                    context = item.optInt("context_length", 0)
                ))
            }
        }.sortedBy { it.name.lowercase() }
    } finally { connection.disconnect() }
}

private suspend fun openRouterChat(
    key: String, model: String, history: List<Pair<String, String>>,
    projectName: String, memory: WorkspaceMemory, onChunk: (String) -> Unit
): String = withContext(Dispatchers.IO) {
    require(key.isNotBlank()) { "Добавь ключ OpenRouter в настройках" }
    require(model.isNotBlank()) { "Выбери модель в настройках" }
    val messages = JSONArray()
    val memoryContext = "Архитектура проекта:\n" + memory.architecture.ifBlank { "не указана" } +
        "\n\nПринятые решения:\n" + memory.decisions.ifBlank { "не указаны" } +
        "\n\nЗнания проекта:\n" + memory.knowledge.ifBlank { "не указаны" }
    messages.put(JSONObject().put("role", "system").put(
        "content",
        "Ты — AI Locman, русскоязычный помощник по разработке. Текущий проект: $projectName. Используй только его память и не смешивай данные проектов.\n\n$memoryContext"
    ))
    history.forEach { (role, content) -> messages.put(JSONObject().put("role", role).put("content", content)) }
    val body = JSONObject().put("model", model).put("messages", messages).put("stream", true)
    val connection = (URL("https://openrouter.ai/api/v1/chat/completions").openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = 15_000
        readTimeout = 120_000
        doOutput = true
        setRequestProperty("Authorization", "Bearer $key")
        setRequestProperty("Content-Type", "application/json; charset=utf-8")
        setRequestProperty("Accept", "text/event-stream")
    }
    try {
        connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        val code = connection.responseCode
        if (code !in 200..299) {
            val raw = connection.errorStream?.bufferedReader()?.use { it.readText() } ?: "{}"
            val detail = runCatching { JSONObject(raw).optJSONObject("error")?.optString("message") }.getOrNull()
            throw IllegalStateException(detail?.takeIf { it.isNotBlank() } ?: "OpenRouter вернул HTTP $code")
        }
        val answer = StringBuilder()
        connection.inputStream.bufferedReader().use { reader ->
            while (true) {
                val line = reader.readLine() ?: break
                if (!line.startsWith("data:")) continue
                val data = line.removePrefix("data:").trim()
                if (data == "[DONE]") break
                val packet = runCatching { JSONObject(data) }.getOrNull() ?: continue
                val delta = packet.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("delta")?.opt("content")
                val chunk = when (delta) {
                    is String -> delta
                    is JSONArray -> buildString {
                        for (i in 0 until delta.length()) {
                            val part = delta.optJSONObject(i)
                            append(part?.optString("text").orEmpty())
                        }
                    }
                    else -> ""
                }
                if (chunk.isNotEmpty()) {
                    answer.append(chunk)
                    withContext(kotlinx.coroutines.Dispatchers.Main) { onChunk(chunk) }
                }
            }
        }
        answer.toString().takeIf { it.isNotBlank() } ?: "Модель вернула пустой ответ"
    } finally { connection.disconnect() }
}

private class BackendApiException(val statusCode: Int, message: String) : IllegalStateException(message)

private suspend fun api(base: String, path: String, method: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
    val root = base.trim().trimEnd('/')
    require(root.startsWith("http://") || root.startsWith("https://")) { "Адрес должен начинаться с http:// или https://" }
    val connection = (URL(root + path).openConnection() as HttpURLConnection).apply {
        requestMethod = method
        connectTimeout = 12_000
        readTimeout = 90_000
        setRequestProperty("Accept", "application/json")
        BackendSession.token()?.let { setRequestProperty("Authorization", "Bearer $it") }
        if (body != null) {
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
    }
    try {
        if (body != null) connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        if (code == 204) return@withContext JSONObject()
        val raw = stream?.bufferedReader()?.use { it.readText() } ?: "{}"
        val json = JSONObject(raw)
        if (code !in 200..299) throw BackendApiException(code, json.optString("error", "HTTP $code"))
        json
    } finally { connection.disconnect() }
}
