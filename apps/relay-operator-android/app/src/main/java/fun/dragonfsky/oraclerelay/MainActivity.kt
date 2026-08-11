package com.dragonfsky.oraclerelay

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.view.View
import android.widget.*
import androidx.core.content.FileProvider
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val polling = AtomicBoolean(false)
    private lateinit var operatorName: String
    private lateinit var api: RelayApi
    private lateinit var status: TextView
    private lateinit var taskSpinner: Spinner
    private lateinit var taskTitle: TextView
    private lateinit var prompt: EditText
    private lateinit var attachments: LinearLayout
    private lateinit var answer: EditText
    private lateinit var responseFilesLabel: TextView
    private lateinit var markSubmittedButton: Button
    private lateinit var abortButton: Button
    private lateinit var submitButton: Button
    private var tasks: List<RelayTask> = emptyList()
    private var activeTask: RelayTask? = null
    private var updatingSpinner = false
    private val downloadedFiles = mutableMapOf<String, File>()
    private val responseUris = mutableListOf<Uri>()
    private val pollRunnable = object : Runnable {
        override fun run() {
            poll()
            main.postDelayed(this, 5_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (RelayConfig.URL.isBlank() || RelayConfig.OPERATOR_TOKEN.isBlank()) {
            Toast.makeText(this, "缺少 Relay 配置，请重新按文档构建安装", Toast.LENGTH_LONG).show()
            finish()
            return
        }
        operatorName = RelayConfig.operatorName(this)
        api = RelayApi(operatorName)
        buildUi()
        requestNotifications()
        val service = Intent(this, RelayPollingService::class.java)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service) else startService(service)
    }

    override fun onStart() {
        super.onStart()
        main.post(pollRunnable)
    }

    override fun onStop() {
        main.removeCallbacks(pollRunnable)
        super.onStop()
    }

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Android")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != FILE_REQUEST || resultCode != RESULT_OK || data == null) return
        val selected = mutableListOf<Uri>()
        data.clipData?.let { clip -> for (index in 0 until clip.itemCount) selected.add(clip.getItemAt(index).uri) }
        data.data?.let(selected::add)
        selected.forEach { uri ->
            runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            if (!responseUris.contains(uri)) responseUris.add(uri)
        }
        updateResponseFilesLabel()
    }

    private fun buildUi() {
        val density = resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(24))
        }
        val scroll = ScrollView(this).apply { addView(container) }
        setContentView(scroll)

        val heading = TextView(this).apply {
            text = "🧿 Oracle Relay 操作端"
            textSize = 22f
            setTypeface(typeface, Typeface.BOLD)
        }
        container.addView(heading)
        status = TextView(this).apply { text = "正在连接 ${RelayConfig.URL}…" }
        container.addView(status)

        taskSpinner = Spinner(this)
        taskSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (!updatingSpinner && position in tasks.indices && tasks[position].id != activeTask?.id) openTask(tasks[position].id)
            }
        }
        container.addView(taskSpinner)
        container.addView(Button(this).apply { text = "立即刷新"; setOnClickListener { poll() } })

        taskTitle = TextView(this).apply { setTypeface(typeface, Typeface.BOLD); textSize = 17f }
        container.addView(taskTitle)
        container.addView(sectionLabel("提示词"))
        prompt = EditText(this).apply {
            isFocusable = false
            minHeight = dp(180)
            setTextIsSelectable(true)
        }
        container.addView(prompt, LinearLayout.LayoutParams.MATCH_PARENT, dp(220))
        container.addView(horizontalRow(
            Button(this).apply { text = "复制提示词"; setOnClickListener { copyPrompt() } },
            Button(this).also { button -> markSubmittedButton = button; button.text = "已粘贴，等待回答"; button.setOnClickListener { markSubmitted() } },
            Button(this).also { button -> abortButton = button; button.text = "中止任务"; button.setOnClickListener { abortTask() } },
        ))

        container.addView(sectionLabel("请求附件"))
        attachments = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        container.addView(attachments)
        container.addView(sectionLabel("回传回答（Markdown）"))
        answer = EditText(this).apply {
            gravity = android.view.Gravity.TOP
            minLines = 8
            hint = "粘贴完整 Markdown 回答"
        }
        container.addView(answer, LinearLayout.LayoutParams.MATCH_PARENT, dp(240))
        responseFilesLabel = TextView(this).apply { text = "未选择回传附件" }
        container.addView(horizontalRow(
            Button(this).apply { text = "添加回传附件…"; setOnClickListener { chooseResponseFiles() } },
            Button(this).apply { text = "清空附件"; setOnClickListener { responseUris.clear(); updateResponseFilesLabel() } },
        ))
        container.addView(responseFilesLabel)
        submitButton = Button(this).apply { text = "提交给开发机"; setOnClickListener { submitResponse() } }
        container.addView(submitButton)
        updateUi()
    }

    private fun sectionLabel(text: String) = TextView(this).apply {
        this.text = text
        textSize = 16f
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, 20, 0, 6)
    }

    private fun horizontalRow(vararg views: View) = HorizontalScrollView(this).apply {
        addView(LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.HORIZONTAL
            views.forEach(::addView)
        })
    }

    private fun poll() {
        if (!polling.compareAndSet(false, true)) return
        runAsync({ api.listTasks() }, { latest ->
            polling.set(false)
            applyTaskList(latest)
        }, { error ->
            polling.set(false)
            status.text = "连接失败：${error.message}"
        })
    }

    private fun applyTaskList(latest: List<RelayTask>) {
        val previousId = activeTask?.id
        tasks = latest
        status.text = "已连接 · ${latest.size} 个待处理任务 · $operatorName"
        updatingSpinner = true
        taskSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, latest.map { "[${it.status}] ${it.title}" })
        updatingSpinner = false
        cleanupCaches(latest.map { it.id }.toSet())
        val current = previousId?.let { id -> latest.firstOrNull { it.id == id } }
        if (current != null) {
            activeTask = current
            selectTask(current.id)
            updateUi()
        } else if (latest.isNotEmpty()) {
            openTask(latest.first().id)
        } else {
            activeTask = null
            downloadedFiles.clear()
            preferences().edit().remove("activeTaskId").apply()
            updateUi()
        }
    }

    private fun openTask(taskId: String) {
        runAsync({
            var task = api.getTask(taskId)
            if (task.status == "queued") task = api.claim(task.id)
            downloadedFiles.clear()
            task.attachments.forEachIndexed { index, attachment ->
                val extension = attachment.filename.substringAfterLast('.', "").takeIf { it.isNotBlank() }?.let { ".$it" } ?: ""
                val destination = File(cacheDirectory(task.id), "attachment-${index + 1}$extension")
                api.downloadAttachment(task.id, attachment, destination)
                downloadedFiles[attachment.id] = destination
            }
            task
        }, { task ->
            activeTask = task
            preferences().edit().putString("activeTaskId", task.id).apply()
            selectTask(task.id)
            updateUi()
        })
    }

    private fun updateUi() {
        val task = activeTask
        if (task == null) {
            taskTitle.text = "暂无任务"
            prompt.setText("")
            answer.setText("")
            attachments.removeAllViews()
            attachments.addView(TextView(this).apply { text = "无附件" })
            setActions(false)
            return
        }
        taskTitle.text = "${task.title} · ${task.status} · 建议模型：${task.modelHint ?: "自行选择"}"
        prompt.setText(task.prompt)
        setActions(task.status in setOf("queued", "claimed", "awaiting-response"))
        renderAttachments(task)
    }

    private fun renderAttachments(task: RelayTask) {
        attachments.removeAllViews()
        if (task.attachments.isEmpty()) {
            attachments.addView(TextView(this).apply { text = "无附件" })
            return
        }
        task.attachments.forEachIndexed { index, attachment ->
            val ready = downloadedFiles[attachment.id] != null
            attachments.addView(horizontalRow(
                TextView(this).apply { text = "附件 ${index + 1} · ${formatBytes(attachment.sizeBytes)} · ${if (ready) "可复制" else "获取中…"}" },
                Button(this).apply {
                    text = "复制/分享"
                    isEnabled = ready
                    setOnClickListener { copyAttachment(attachment) }
                },
            ))
        }
    }

    private fun setActions(enabled: Boolean) {
        markSubmittedButton.isEnabled = enabled
        abortButton.isEnabled = enabled
        submitButton.isEnabled = enabled
        answer.isEnabled = enabled
    }

    private fun copyPrompt() {
        val task = activeTask ?: return
        clipboard().setPrimaryClip(ClipData.newPlainText("Oracle Relay prompt", task.prompt))
        toast("提示词已复制")
    }

    private fun copyAttachment(attachment: RelayAttachment) {
        val file = downloadedFiles[attachment.id] ?: return
        try {
            if (isTextAttachment(attachment)) {
                clipboard().setPrimaryClip(ClipData.newPlainText("Oracle Relay attachment", file.readText()))
                toast("附件内容已复制")
                return
            }
            val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
            clipboard().setPrimaryClip(ClipData.newUri(contentResolver, attachment.filename, uri))
            val share = Intent(Intent.ACTION_SEND).apply {
                type = attachment.mimeType ?: "application/octet-stream"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(share, "复制后分享到 AI 客户端"))
        } catch (error: Exception) {
            showError(error)
        }
    }

    private fun markSubmitted() {
        val task = activeTask ?: return
        runAsync({ api.markSubmitted(task.id) }, { updated ->
            activeTask = updated
            updateUi()
            toast("已进入等待回答状态")
        })
    }

    private fun abortTask() {
        val task = activeTask ?: return
        android.app.AlertDialog.Builder(this)
            .setTitle("确定中止任务？")
            .setMessage("开发机上的等待会立即结束。外部 AI 客户端中的生成需要另行停止。")
            .setNegativeButton("取消", null)
            .setPositiveButton("中止任务") { _, _ ->
                runAsync({ api.abort(task.id) }, {
                    removeCache(task.id)
                    activeTask = null
                    preferences().edit().remove("activeTaskId").apply()
                    poll()
                })
            }
            .show()
    }

    private fun chooseResponseFiles() {
        startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            addCategory(Intent.CATEGORY_OPENABLE)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }, FILE_REQUEST)
    }

    private fun submitResponse() {
        val task = activeTask ?: return
        val markdown = answer.text.toString().trim()
        if (markdown.isBlank() && responseUris.isEmpty()) {
            toast("请粘贴回答或选择回传附件")
            return
        }
        submitButton.isEnabled = false
        runAsync({
            val files = responseUris.map { uri ->
                ResponseFile(
                    filename = displayName(uri),
                    mimeType = contentResolver.getType(uri),
                    bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        ?: error("无法读取回传附件：${displayName(uri)}"),
                )
            }
            api.submitResponse(task.id, markdown, files)
        }, {
            removeCache(task.id)
            activeTask = null
            answer.setText("")
            responseUris.clear()
            preferences().edit().remove("activeTaskId").apply()
            updateResponseFilesLabel()
            toast("回答已回传，临时附件已删除")
            poll()
        }, { error ->
            submitButton.isEnabled = true
            showError(error)
        })
    }

    private fun displayName(uri: Uri): String {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) return cursor.getString(0)
        }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "attachment.bin"
    }

    private fun selectTask(taskId: String) {
        val index = tasks.indexOfFirst { it.id == taskId }
        if (index >= 0) {
            updatingSpinner = true
            taskSpinner.setSelection(index)
            updatingSpinner = false
        }
    }

    private fun updateResponseFilesLabel() {
        responseFilesLabel.text = if (responseUris.isEmpty()) "未选择回传附件" else "已选择 ${responseUris.size} 个回传附件"
    }

    private fun cacheDirectory(taskId: String) = File(cacheDir, "relay/${safeName(taskId)}").apply { mkdirs() }

    private fun removeCache(taskId: String) { cacheDirectory(taskId).deleteRecursively(); downloadedFiles.clear() }

    private fun cleanupCaches(activeIds: Set<String>) {
        File(cacheDir, "relay").listFiles()?.filter { it.name !in activeIds }?.forEach(File::deleteRecursively)
    }

    private fun safeName(value: String) = value.replace(Regex("[^A-Za-z0-9._-]+"), "-").ifBlank { "task" }

    private fun isTextAttachment(attachment: RelayAttachment): Boolean {
        if (attachment.mimeType?.startsWith("text/", ignoreCase = true) == true) return true
        return attachment.filename.substringAfterLast('.', "").lowercase() in setOf(
            "txt", "md", "json", "jsonl", "js", "jsx", "ts", "tsx", "css", "html", "xml", "yaml", "yml",
            "toml", "csv", "log", "diff", "patch", "java", "kt", "kts", "gradle", "properties", "sql", "sh",
            "py", "rb", "go", "rs", "c", "cpp", "h", "cs",
        )
    }

    private fun formatBytes(bytes: Long): String = when {
        bytes >= 1_073_741_824 -> "%.1f GB".format(bytes / 1_073_741_824.0)
        bytes >= 1_048_576 -> "%.1f MB".format(bytes / 1_048_576.0)
        bytes >= 1024 -> "%.1f KB".format(bytes / 1024.0)
        else -> "$bytes B"
    }

    private fun clipboard() = getSystemService(ClipboardManager::class.java)

    private fun preferences() = getSharedPreferences(RelayPollingService.PREFERENCES, MODE_PRIVATE)

    private fun requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 90)
        }
    }

    private fun <T> runAsync(
        work: () -> T,
        success: (T) -> Unit,
        failure: (Exception) -> Unit = ::showError,
    ) {
        executor.execute {
            try {
                val result = work()
                main.post { if (!isFinishing) success(result) }
            } catch (error: Exception) {
                main.post { if (!isFinishing) failure(error) }
            }
        }
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_SHORT).show()

    private fun showError(error: Exception) {
        android.app.AlertDialog.Builder(this)
            .setTitle("Oracle Relay")
            .setMessage(error.message ?: error.javaClass.simpleName)
            .setPositiveButton("确定", null)
            .show()
    }

    companion object {
        private const val FILE_REQUEST = 701
    }
}
