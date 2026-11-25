package cloud.atomicpel.ailocman

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

private data class ChatLine(val role: String, val text: String)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("ai_locman", MODE_PRIVATE)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(
                primary = Color(0xFF8BB8FF), secondary = Color(0xFF83D6C5),
                background = Color(0xFF0B1020), surface = Color(0xFF151D30)
            )) {
                LocmanHome(
                    initialServer = prefs.getString("server", "http://10.0.2.2:8080") ?: "http://10.0.2.2:8080",
                    onSaveServer = { prefs.edit().putString("server", it).apply() }
                )
            }
        }
    }
}

@Composable
private fun LocmanHome(initialServer: String, onSaveServer: (String) -> Unit) {
    var localMode by remember { mutableStateOf(true) }
    var server by remember { mutableStateOf(initialServer) }
    var projectName by remember { mutableStateOf("Мой первый проект") }
    var model by remember { mutableStateOf("openai/gpt-4o-mini") }
    var apiKey by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("Локальный тест: введи ключ OpenRouter и отправь сообщение") }
    val lines = remember { mutableStateListOf(ChatLine("assistant", "Привет! Я AI Locman. Сейчас включён локальный тестовый режим: запросы идут напрямую в OpenRouter, backend не требуется.")) }
    val scope = rememberCoroutineScope()

    fun runRequest(block: suspend () -> Unit) {
        if (busy) return
        scope.launch {
            busy = true
            try { block() } catch (e: Exception) { status = e.message ?: "Ошибка соединения" }
            finally { busy = false }
        }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Column(Modifier.fillMaxWidth().background(Color(0xFF111A2C)).padding(horizontal = 18.dp, vertical = 14.dp)) {
                Text("AI LOCMAN", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = Color(0xFFBBD4FF))
                Text("Мобильная студия автономной разработки", style = MaterialTheme.typography.bodySmall, color = Color(0xFF9EABC3))
            }
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(14.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Режим работы", fontWeight = FontWeight.SemiBold)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(selected = localMode, onClick = { localMode = true; status = "Локальный тест: backend не требуется" }, label = { Text("Local AI Test") })
                        FilterChip(selected = !localMode, onClick = { localMode = false; status = "Backend mode: укажи адрес сервера" }, label = { Text("Backend") })
                    }
                    if (localMode) {
                        OutlinedTextField(value = apiKey, onValueChange = { apiKey = it.trim() }, modifier = Modifier.fillMaxWidth(), singleLine = true, label = { Text("OpenRouter API key") }, visualTransformation = PasswordVisualTransformation())
                        Text("Ключ хранится только в памяти приложения и исчезнет после его закрытия. Используй отдельный тестовый ключ с небольшим лимитом.", color = Color(0xFFFFD18A), style = MaterialTheme.typography.bodySmall)
                    } else {
                        OutlinedTextField(value = server, onValueChange = { server = it }, modifier = Modifier.fillMaxWidth(), singleLine = true, label = { Text("Адрес backend") })
                    }
                    OutlinedTextField(value = projectName, onValueChange = { projectName = it }, modifier = Modifier.fillMaxWidth(), singleLine = true, label = { Text("Название проекта (локально)") })
                    OutlinedTextField(value = model, onValueChange = { model = it }, modifier = Modifier.fillMaxWidth(), singleLine = true, label = { Text("Модель") })
                    if (!localMode) {
                        Button(enabled = !busy, onClick = {
                            onSaveServer(server.trim().trimEnd('/'))
                            runRequest {
                                val json = JSONObject().put("name", projectName).put("description", "Проект AI Locman")
                                val result = api(server, "/api/v1/projects", "POST", json)
                                projectId = result.getString("id")
                                status = "Проект создан на backend"
                            }
                        }) { Text("Создать проект на сервере") }
                    } else {
                        Text("Проект тестовой сессии: $projectName", color = Color(0xFF83D6C5), style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
            Text(status, color = MaterialTheme.colorScheme.secondary, style = MaterialTheme.typography.bodySmall)
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(lines) { line ->
                    val user = line.role == "user"
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (user) Arrangement.End else Arrangement.Start) {
                        Surface(color = if (user) Color(0xFF243B60) else Color(0xFF19243A), shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth(0.92f)) {
                            Column(Modifier.padding(12.dp)) {
                                Text(if (user) "ТЫ" else "AI LOCMAN", color = if (user) Color(0xFFBBD4FF) else Color(0xFF83D6C5), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                                Spacer(Modifier.height(4.dp))
                                Text(line.text, color = Color(0xFFE7ECF5), style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
            }
            OutlinedTextField(value = prompt, onValueChange = { prompt = it }, modifier = Modifier.fillMaxWidth(), placeholder = { Text("Опиши, что нужно сделать…") }, minLines = 2, maxLines = 5)
            Button(
                enabled = !busy && prompt.isNotBlank() && (if (localMode) apiKey.startsWith("sk-or-") else projectId.isNotBlank()),
                onClick = {
                    val text = prompt.trim()
                    prompt = ""
                    lines.add(ChatLine("user", text))
                    val history = lines.map { it.role to it.text }
                    runRequest {
                        status = if (localMode) "Запрос напрямую в OpenRouter…" else "Агент обращается к backend…"
                        val answer = if (localMode) {
                            openRouterChat(apiKey, model.trim(), history)
                        } else {
                            val body = JSONObject().put("projectId", projectId).put("model", model.trim()).put("message", text)
                            api(server, "/api/v1/chat", "POST", body).optString("answer", "Пустой ответ модели")
                        }
                        lines.add(ChatLine("assistant", answer))
                        status = "Ответ получен · $model"
                    }
                }, modifier = Modifier.fillMaxWidth()
            ) { Text(if (busy) "Выполняется…" else "Отправить") }
        }
    }
}

private suspend fun openRouterChat(key: String, model: String, history: List<Pair<String, String>>): String = withContext(Dispatchers.IO) {
    require(key.startsWith("sk-or-")) { "Введи действительный ключ OpenRouter (обычно начинается с sk-or-)" }
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

private var projectId: String = ""

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
        val text = stream?.bufferedReader()?.use { it.readText() } ?: "{}"
        val json = JSONObject(text)
        if (code !in 200..299) throw IllegalStateException(json.optString("error", "HTTP $code"))
        json
    } finally { connection.disconnect() }
}
