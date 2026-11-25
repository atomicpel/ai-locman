package cloud.atomicpel.ailocman

import android.os.Bundle
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
    initialServer: String,
    initialModel: String,
    initialKey: String,
    initialLocalMode: Boolean,
    initialProject: String,
    onSaveSettings: (String, String, Boolean, String) -> Unit,
    onSaveKey: (String) -> Unit
) {
    var showSettings by remember { mutableStateOf(false) }
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
    var projectId by remember { mutableStateOf("") }
    val lines = remember { mutableStateListOf(ChatLine("assistant", "Привет! Я Лоцман. Чем займёмся сегодня?")) }
    val scope = rememberCoroutineScope()

    fun runTask(block: suspend () -> Unit) {
        if (busy) return
        scope.launch {
            busy = true
            try { block() } catch (e: Exception) { status = e.message ?: "Неизвестная ошибка" }
            finally { busy = false }
        }
    }

    Scaffold(
        containerColor = Navy,
        contentWindowInsets = WindowInsets.safeDrawing,
        topBar = {
            Row(
                Modifier.fillMaxWidth().background(Navy).padding(horizontal = 20.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    Modifier.size(42.dp).background(Accent.copy(alpha = .14f), CircleShape),
                    contentAlignment = Alignment.Center
                ) { Text("L", color = Accent, fontWeight = FontWeight.Black, style = MaterialTheme.typography.titleLarge) }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text("AI LOCMAN", color = MainText, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                    Text("ТВОЯ AI-СТУДИЯ", color = Muted, style = MaterialTheme.typography.labelSmall)
                }
                if (showSettings) {
                    TextButton(onClick = { showSettings = false }) { Text("Назад", color = Accent) }
                } else {
                    IconButton(onClick = { showSettings = true }) {
                        Text("⚙", color = MainText, style = MaterialTheme.typography.headlineSmall)
                    }
                }
            }
        },
        bottomBar = {
            if (!showSettings) {
                Column(Modifier.fillMaxWidth().background(Navy).navigationBarsPadding().imePadding().padding(horizontal = 14.dp, vertical = 10.dp)) {
                    Row(
                        Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(22.dp)).padding(6.dp),
                        verticalAlignment = Alignment.Bottom
                    ) {
                        OutlinedTextField(
                            value = prompt, onValueChange = { prompt = it },
                            modifier = Modifier.weight(1f),
                            placeholder = { Text("Напиши задачу Лоцману…", color = Muted) },
                            minLines = 1, maxLines = 4,
                            shape = RoundedCornerShape(18.dp),
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
                                    lines.add(ChatLine("user", text))
                                    val history = lines.map { it.role to it.text }
                                    runTask {
                                        status = "Отправляю запрос…"
                                        val answer = if (localMode) {
                                            openRouterChat(apiKey, model, history)
                                        } else {
                                            require(projectId.isNotBlank()) { "Сначала создай проект в настройках Backend" }
                                            api(server, "/api/v1/chat", "POST",
                                                JSONObject().put("projectId", projectId).put("model", model).put("message", text)
                                            ).optString("answer", "Пустой ответ")
                                        }
                                        lines.add(ChatLine("assistant", answer))
                                        status = "Ответ получен"
                                    }
                                }
                            },
                            enabled = !busy && prompt.isNotBlank() && (if (localMode) apiKey.isNotBlank() else projectId.isNotBlank()),
                            contentPadding = PaddingValues(horizontal = 17.dp, vertical = 14.dp),
                            shape = RoundedCornerShape(16.dp)
                        ) { Text(if (busy) "…" else "➤", style = MaterialTheme.typography.titleMedium) }
                    }
                }
            }
        }
    ) { padding ->
        if (showSettings) {
            SettingsScreen(
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
                    showSettings = false
                }
            )
        } else {
            Column(Modifier.fillMaxSize().padding(padding)) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Surface(color = Panel2, shape = RoundedCornerShape(50)) {
                        Row(Modifier.padding(horizontal = 12.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(7.dp).background(if (localMode) Accent else Blue, CircleShape))
                            Spacer(Modifier.width(7.dp))
                            Text(if (localMode) "LOCAL AI" else "BACKEND", color = MainText, style = MaterialTheme.typography.labelMedium)
                        }
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(model.substringAfterLast('/'), color = Muted, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                }
                HorizontalDivider(color = Color.White.copy(alpha = .07f))
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp),
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
                                modifier = Modifier.fillMaxWidth(if (isUser) .88f else .94f)
                            ) {
                                Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
                                    Text(if (isUser) "ВЫ" else "ЛОЦМАН", color = if (isUser) Blue else Accent,
                                        style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                                    Spacer(Modifier.height(5.dp))
                                    Text(line.text, color = MainText, style = MaterialTheme.typography.bodyMedium)
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
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 5.dp), maxLines = 1)
                }
            }
        }
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

private suspend fun openRouterChat(key: String, model: String, history: List<Pair<String, String>>): String = withContext(Dispatchers.IO) {
    require(key.isNotBlank()) { "Добавь ключ OpenRouter в настройках" }
    require(model.isNotBlank()) { "Выбери модель в настройках" }
    val messages = JSONArray()
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
        val raw = stream?.bufferedReader()?.use { it.readText() } ?: "{}"
        val json = JSONObject(raw)
        if (code !in 200..299) throw IllegalStateException(json.optString("error", "HTTP $code"))
        json
    } finally { connection.disconnect() }
}
