package cloud.atomicpel.ailocman

import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal data class WorkspaceProject(
    val id: String,
    val name: String,
    val description: String = "",
    val model: String = "openrouter/auto"
)

internal data class WorkspaceConversation(
    val id: String,
    val title: String,
    val preview: String = ""
)

internal data class WorkspaceMessage(
    val role: String,
    val content: String
)

internal data class WorkspaceMemory(
    val architecture: String = "",
    val decisions: String = "",
    val knowledge: String = ""
)


internal data class WorkspaceTask(
    val id: String,
    val prompt: String,
    val model: String,
    val status: String,
    val result: String = "",
    val error: String = "",
    val conversationId: String = ""
)

internal object WorkspaceStore {
    private const val PROJECTS_KEY = "workspace_projects"

    fun ensureProjects(prefs: SharedPreferences): List<WorkspaceProject> {
        val saved = loadProjects(prefs)
        if (saved.isNotEmpty()) return saved
        val initial = WorkspaceProject(
            id = prefs.getString("active_project_id", null) ?: UUID.randomUUID().toString(),
            name = prefs.getString("project", "Мой первый проект") ?: "Мой первый проект",
            model = prefs.getString("model", "openrouter/auto") ?: "openrouter/auto"
        )
        saveProjects(prefs, listOf(initial))
        prefs.edit().putString("active_project_id", initial.id).apply()
        return listOf(initial)
    }

    fun loadProjects(prefs: SharedPreferences): List<WorkspaceProject> {
        val raw = prefs.getString(PROJECTS_KEY, null) ?: return emptyList()
        return runCatching {
            val array = JSONArray(raw)
            (0 until array.length()).mapNotNull { i ->
                val item = array.optJSONObject(i) ?: return@mapNotNull null
                val id = item.optString("id")
                if (id.isBlank()) null else WorkspaceProject(
                    id = id,
                    name = item.optString("name", "Проект"),
                    description = item.optString("description"),
                    model = item.optString("model", "openrouter/auto")
                )
            }
        }.getOrDefault(emptyList())
    }

    fun saveProjects(prefs: SharedPreferences, projects: List<WorkspaceProject>) {
        val array = JSONArray()
        projects.forEach { project ->
            array.put(JSONObject()
                .put("id", project.id)
                .put("name", project.name)
                .put("description", project.description)
                .put("model", project.model))
        }
        prefs.edit().putString(PROJECTS_KEY, array.toString()).apply()
    }

    private fun conversationKey(projectId: String) = "local_conversations_$projectId"
    private fun memoryKey(projectId: String) = "local_memory_$projectId"

    fun loadConversations(prefs: SharedPreferences, projectId: String): List<WorkspaceConversation> {
        val raw = prefs.getString(conversationKey(projectId), null) ?: return emptyList()
        return runCatching {
            val array = JSONArray(raw)
            (0 until array.length()).mapNotNull { i ->
                val item = array.optJSONObject(i) ?: return@mapNotNull null
                val id = item.optString("id")
                if (id.isBlank()) null else WorkspaceConversation(
                    id = id,
                    title = item.optString("title", "Новый чат"),
                    preview = item.optString("preview")
                )
            }.sortedByDescending { item ->
                runCatching {
                    val array = JSONArray(raw)
                    (0 until array.length()).firstOrNull { array.optJSONObject(it)?.optString("id") == item.id }
                        ?.let { array.optJSONObject(it)?.optLong("updatedAt") ?: 0L } ?: 0L
                }.getOrDefault(0L)
            }
        }.getOrDefault(emptyList())
    }

    fun loadMessages(prefs: SharedPreferences, projectId: String, conversationId: String): List<WorkspaceMessage> {
        val raw = prefs.getString(conversationKey(projectId), null) ?: return emptyList()
        return runCatching {
            val array = JSONArray(raw)
            val item = (0 until array.length()).mapNotNull { array.optJSONObject(it) }
                .firstOrNull { it.optString("id") == conversationId } ?: return@runCatching emptyList()
            val messages = item.optJSONArray("messages") ?: JSONArray()
            (0 until messages.length()).mapNotNull { i ->
                val message = messages.optJSONObject(i) ?: return@mapNotNull null
                val role = message.optString("role")
                val content = message.optString("content")
                if (role !in listOf("user", "assistant") || content.isBlank()) null
                else WorkspaceMessage(role, content)
            }
        }.getOrDefault(emptyList())
    }

    fun saveConversation(
        prefs: SharedPreferences,
        projectId: String,
        conversationId: String,
        title: String,
        messages: List<WorkspaceMessage>
    ) {
        val key = conversationKey(projectId)
        val raw = prefs.getString(key, null)
        val existing = runCatching { JSONArray(raw ?: "[]") }.getOrDefault(JSONArray())
        val updated = JSONArray()
        var found = false
        for (i in 0 until existing.length()) {
            val item = existing.optJSONObject(i) ?: continue
            if (item.optString("id") == conversationId) {
                updated.put(conversationJson(conversationId, title, messages))
                found = true
            } else updated.put(item)
        }
        if (!found) updated.put(conversationJson(conversationId, title, messages))
        prefs.edit().putString(key, updated.toString()).apply()
    }

    private fun conversationJson(
        id: String,
        title: String,
        messages: List<WorkspaceMessage>
    ): JSONObject {
        val messageArray = JSONArray()
        messages.forEach { message ->
            messageArray.put(JSONObject().put("role", message.role).put("content", message.content))
        }
        return JSONObject()
            .put("id", id)
            .put("title", title)
            .put("preview", messages.lastOrNull()?.content?.take(120) ?: "")
            .put("updatedAt", System.currentTimeMillis())
            .put("messages", messageArray)
    }

    fun renameConversation(prefs: SharedPreferences, projectId: String, conversationId: String, title: String) {
        val key = conversationKey(projectId)
        val existing = runCatching { JSONArray(prefs.getString(key, "[]") ?: "[]") }.getOrDefault(JSONArray())
        val updated = JSONArray()
        for (i in 0 until existing.length()) {
            val item = existing.optJSONObject(i) ?: continue
            if (item.optString("id") == conversationId) {
                item.put("title", title)
                item.put("updatedAt", System.currentTimeMillis())
            }
            updated.put(item)
        }
        prefs.edit().putString(key, updated.toString()).apply()
    }

    fun deleteConversation(prefs: SharedPreferences, projectId: String, conversationId: String) {
        val key = conversationKey(projectId)
        val existing = runCatching { JSONArray(prefs.getString(key, "[]") ?: "[]") }.getOrDefault(JSONArray())
        val updated = JSONArray()
        for (i in 0 until existing.length()) {
            val item = existing.optJSONObject(i) ?: continue
            if (item.optString("id") != conversationId) updated.put(item)
        }
        prefs.edit().putString(key, updated.toString()).apply()
    }

    fun loadMemory(prefs: SharedPreferences, projectId: String): WorkspaceMemory {
        val raw = prefs.getString(memoryKey(projectId), null) ?: return WorkspaceMemory()
        return runCatching {
            val json = JSONObject(raw)
            WorkspaceMemory(
                architecture = json.optString("architecture"),
                decisions = json.optString("decisions"),
                knowledge = json.optString("knowledge")
            )
        }.getOrDefault(WorkspaceMemory())
    }

    fun saveMemory(prefs: SharedPreferences, projectId: String, memory: WorkspaceMemory) {
        val json = JSONObject()
            .put("architecture", memory.architecture)
            .put("decisions", memory.decisions)
            .put("knowledge", memory.knowledge)
        prefs.edit().putString(memoryKey(projectId), json.toString()).apply()
    }
}
