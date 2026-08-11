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
    private var languageSetting: String = "system"
    private var tasks: List<RelayTask> = emptyList()
    private var activeTask: RelayTask? = null
    private var updatingSpinner = false
    private val downloadedFiles = mutableMapOf<String, File>()
    private val responseUris = mutableListOf<Uri>()
    private var pendingDraftTaskId: String? = null
    private var pendingDraftText = ""
    private val pendingDraftUris = mutableListOf<Uri>()
    private val pollRunnable = object : Runnable {
        override fun run() {
            poll()
            main.postDelayed(this, 5_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        languageSetting = preferences().getString("language", "system") ?: "system"
        if (RelayConfig.URL.isBlank() || RelayConfig.OPERATOR_TOKEN.isBlank()) {
            Toast.makeText(this, t("error.missing-config"), Toast.LENGTH_LONG).show()
            finish()
            return
        }
        operatorName = RelayConfig.operatorName(this)
        api = RelayApi(operatorName) { languageSetting }
        buildUi()
        restoreDraft(savedInstanceState)
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

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("responseDraft", if (::answer.isInitialized) answer.text.toString() else "")
        outState.putStringArrayList("responseUris", ArrayList(responseUris.map(Uri::toString)))
        outState.putString("responseDraftTaskId", activeTask?.id)
        super.onSaveInstanceState(outState)
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
            text = t("app.title")
            textSize = 22f
            setTypeface(typeface, Typeface.BOLD)
        }
        container.addView(heading)
        status = TextView(this).apply { text = t("connecting", "url" to RelayConfig.URL) }
        container.addView(status)
        val languageChoices = listOf("system", "zh-CN", "en")
        container.addView(Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item,
                languageChoices.map { t("language.$it") })
            setSelection(languageChoices.indexOf(languageSetting).coerceAtLeast(0))
            onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
                override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
                    val next = languageChoices[position]
                    if (next != languageSetting) { preferences().edit().putString("language", next).apply(); recreate() }
                }
            }
        })

        taskSpinner = Spinner(this)
        taskSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (!updatingSpinner && position in tasks.indices && tasks[position].id != activeTask?.id) openTask(tasks[position].id)
            }
        }
        container.addView(taskSpinner)
        container.addView(Button(this).apply { text = t("refresh"); setOnClickListener { poll() } })

        taskTitle = TextView(this).apply { setTypeface(typeface, Typeface.BOLD); textSize = 17f }
        container.addView(taskTitle)
        container.addView(sectionLabel(t("prompt")))
        prompt = EditText(this).apply {
            isFocusable = false
            minHeight = dp(180)
            setTextIsSelectable(true)
        }
        container.addView(prompt, LinearLayout.LayoutParams.MATCH_PARENT, dp(220))
        container.addView(horizontalRow(
            Button(this).apply { text = t("copy.prompt"); setOnClickListener { copyPrompt() } },
            Button(this).also { button -> markSubmittedButton = button; button.text = t("mark.submitted"); button.setOnClickListener { markSubmitted() } },
            Button(this).also { button -> abortButton = button; button.text = t("abort"); button.setOnClickListener { abortTask() } },
        ))

        container.addView(sectionLabel(t("attachments.request")))
        attachments = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        container.addView(attachments)
        container.addView(sectionLabel(t("answer")))
        answer = EditText(this).apply {
            gravity = android.view.Gravity.TOP
            minLines = 8
            hint = t("answer.placeholder")
        }
        container.addView(answer, LinearLayout.LayoutParams.MATCH_PARENT, dp(240))
        responseFilesLabel = TextView(this).apply { text = t("response.files.none") }
        container.addView(horizontalRow(
            Button(this).apply { text = t("response.files.add"); setOnClickListener { chooseResponseFiles() } },
            Button(this).apply { text = t("response.files.clear"); setOnClickListener { responseUris.clear(); updateResponseFilesLabel() } },
        ))
        container.addView(responseFilesLabel)
        submitButton = Button(this).apply { text = t("answer.submit"); setOnClickListener { submitResponse() } }
        container.addView(submitButton)
        updateUi()
    }

    private fun restoreDraft(state: Bundle?) {
        pendingDraftText = state?.getString("responseDraft") ?: return
        pendingDraftTaskId = state.getString("responseDraftTaskId")
        pendingDraftUris.addAll(state.getStringArrayList("responseUris")?.map(Uri::parse).orEmpty())
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
            status.text = t("connection.failed", "message" to (error.message ?: error.javaClass.simpleName))
        })
    }

    private fun applyTaskList(latest: List<RelayTask>) {
        val previousId = activeTask?.id ?: preferences().getString("activeTaskId", null)
        tasks = latest
        status.text = t("connected", "count" to latest.size, "operator" to operatorName)
        updatingSpinner = true
        taskSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, latest.map { "[${statusLabel(it.status)}] ${it.title}" })
        updatingSpinner = false
        cleanupCaches(latest.map { it.id }.toSet())
        val current = previousId?.let { id -> latest.firstOrNull { it.id == id } }
        if (current != null) {
            activeTask = current
            selectTask(current.id)
            updateUi()
            applyPendingDraft(current.id)
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
            applyPendingDraft(task.id)
        })
    }

    private fun updateUi() {
        val task = activeTask
        if (task == null) {
            taskTitle.text = t("task.none")
            prompt.setText("")
            answer.setText("")
            attachments.removeAllViews()
            attachments.addView(TextView(this).apply { text = t("attachments.none") })
            setActions(false)
            return
        }
        taskTitle.text = "${task.title} · ${t("task.status", "status" to statusLabel(task.status))} · ${t("task.model", "model" to (task.modelHint ?: "—"))}"
        prompt.setText(task.prompt)
        setActions(task.status in setOf("queued", "claimed", "awaiting-response"))
        renderAttachments(task)
    }

    private fun applyPendingDraft(taskId: String) {
        if (pendingDraftTaskId != taskId) return
        answer.setText(pendingDraftText)
        pendingDraftUris.forEach { uri -> if (!responseUris.contains(uri)) responseUris.add(uri) }
        pendingDraftText = ""
        pendingDraftTaskId = null
        pendingDraftUris.clear()
        updateResponseFilesLabel()
    }

    private fun renderAttachments(task: RelayTask) {
        attachments.removeAllViews()
        if (task.attachments.isEmpty()) {
            attachments.addView(TextView(this).apply { text = t("attachments.none") })
            return
        }
        task.attachments.forEachIndexed { index, attachment ->
            val ready = downloadedFiles[attachment.id] != null
            attachments.addView(horizontalRow(
                TextView(this).apply { text = "${t("attachments")} ${index + 1} · ${formatBytes(attachment.sizeBytes)} · ${if (ready) t("attachment.ready") else t("attachment.loading")}" },
                Button(this).apply {
                    text = t("copy.attachment")
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
        toast(t("copy.success"))
    }

    private fun copyAttachment(attachment: RelayAttachment) {
        val file = downloadedFiles[attachment.id] ?: return
        try {
            if (isTextAttachment(attachment)) {
                clipboard().setPrimaryClip(ClipData.newPlainText("Oracle Relay attachment", file.readText()))
                toast(t("attachment.copied"))
                return
            }
            val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
            clipboard().setPrimaryClip(ClipData.newUri(contentResolver, attachment.filename, uri))
            val share = Intent(Intent.ACTION_SEND).apply {
                type = attachment.mimeType ?: "application/octet-stream"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(share, t("copy.attachment")))
        } catch (error: Exception) {
            showError(error)
        }
    }

    private fun markSubmitted() {
        val task = activeTask ?: return
        runAsync({ api.markSubmitted(task.id) }, { updated ->
            activeTask = updated
            updateUi()
            toast(t("answer.waiting"))
        })
    }

    private fun abortTask() {
        val task = activeTask ?: return
        android.app.AlertDialog.Builder(this)
            .setTitle(t("abort.title"))
            .setMessage(t("abort.message"))
            .setNegativeButton(t("cancel"), null)
            .setPositiveButton(t("abort")) { _, _ ->
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
            toast(t("validation.response-required"))
            return
        }
        submitButton.isEnabled = false
        runAsync({
            val files = responseUris.map { uri ->
                ResponseFile(
                    filename = displayName(uri),
                    mimeType = contentResolver.getType(uri),
                    bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        ?: error(t("error.request", "status" to "read", "detail" to displayName(uri))),
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
            toast(t("answer.submitted"))
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
        responseFilesLabel.text = if (responseUris.isEmpty()) t("response.files.none") else t("response.files.selected", "count" to responseUris.size)
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
            .setTitle(t("error.title"))
            .setMessage(error.message ?: error.javaClass.simpleName)
            .setPositiveButton(t("confirm"), null)
            .show()
    }

    private fun t(key: String, vararg values: Pair<String, Any>) = OperatorLocale.t(key, languageSetting, values.toMap())
    private fun statusLabel(raw: String) = if (raw in setOf("uploading", "queued", "claimed", "awaiting-response", "completed", "cancelled", "expired")) t("status.$raw") else raw

    companion object {
        private const val FILE_REQUEST = 701
    }
}
