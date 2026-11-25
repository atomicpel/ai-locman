package cloud.atomicpel.ailocman

import android.os.Bundle
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
                    initialLocalMode = prefs.getBoolean("local_mode", true),
                    initialProject = prefs.getString("project", "Мой первый проект") ?: "Мой первый проект",
                    onSaveSettings = { server, model, local, project ->
                        prefs.edit().putString("server", server).putString("model", model)
                            .putBoolean("local_mode", local).putString("project", project).apply()
                    },
                    onSaveKey = { key -> securePrefs?.edit()?.putString("openrouter_key", key)?.apply() }
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
    initialLocalMode: Boolean,
    initialProject: String,
    onSaveSettings: (String, String, Boolean, String) -> Unit,
    onSaveKey: (String) -> Unit
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
    var prompt by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("Готов к работе") }
    var models by remember { mutableStateOf<List<ModelInfo>>(emptyList()) }
    var modelSearch by remember { mutableStateOf("") }
    var showModelPicker by remember { mutableStateOf(false) }
    var tasks by remember { mutableStateOf<List<WorkspaceTask>>(emptyList()) }
    val monitoredTaskIds = remember { mutableStateListOf<String>() }
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
                                        val answer = if (localMode) {
                                            openRouterChat(
                                                apiKey, model, history, projects.firstOrNull { it.id == projectId }?.name ?: projectName,
                                                memory
                                            )
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
                                        lines.add(ChatLine("assistant", answer))
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
                            JSONObject().put("name", projectName).put("description", "Проект AI Locman"))
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
                        preferences.edit().putString("active_project_id", selected.id).putString("project", selected.name).apply()
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
                            val item = WorkspaceProject(UUID.randomUUID().toString(), name)
                            projects = projects + item
                            WorkspaceStore.saveProjects(preferences, projects)
                            item
                        } else {
                            val json = api(server, "/api/v1/projects", "POST", JSONObject().put("name", name).put("description", "Проект AI Locman"))
                            WorkspaceProject(json.getString("id"), json.optString("name", name), json.optString("description"))
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

private suspend fun loadBackendProjects(server: String): List<WorkspaceProject> {
    val data = api(server, "/api/v1/projects", "GET").optJSONArray("items") ?: JSONArray()
    return (0 until data.length()).mapNotNull { i ->
        data.optJSONObject(i)?.let { item ->
            val id = item.optString("id")
            if (id.isBlank()) null else WorkspaceProject(id, item.optString("name", "Проект"), item.optString("description"))
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
    projectName: String, memory: WorkspaceMemory
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
    val body = JSONObject().put("model", model).put("messages", messages)
    val connection = (URL("https://openrouter.ai/api/v1/chat/completions").openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = 15_000
        readTimeout = 120_000
        doOutput = true
        setRequestProperty("Authorization", "Bearer $key")
        setRequestProperty("Content-Type", "application/json; charset=utf-8")
        setRequestProperty("Accept", "application/json")
    }
    try {
        connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        val raw = stream?.bufferedReader()?.use { it.readText() } ?: "{}"
        val json = JSONObject(raw)
        if (code !in 200..299) {
            val detail = json.optJSONObject("error")?.optString("message")
            throw IllegalStateException(detail?.takeIf { it.isNotBlank() } ?: "OpenRouter вернул HTTP $code")
        }
        json.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.optString("content")
            ?.takeIf { it.isNotBlank() } ?: "Модель вернула пустой ответ"
    } finally { connection.disconnect() }
}

private suspend fun api(base: String, path: String, method: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
    val root = base.trim().trimEnd('/')
    require(root.startsWith("http://") || root.startsWith("https://")) { "Адрес должен начинаться с http:// или https://" }
    val connection = (URL(root + path).openConnection() as HttpURLConnection).apply {
        requestMethod = method
        connectTimeout = 12_000
        readTimeout = 90_000
        setRequestProperty("Accept", "application/json")
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
        if (code !in 200..299) throw IllegalStateException(json.optString("error", "HTTP $code"))
        json
    } finally { connection.disconnect() }
}
