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
