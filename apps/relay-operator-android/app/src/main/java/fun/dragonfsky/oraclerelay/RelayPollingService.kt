package com.dragonfsky.oraclerelay

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class RelayPollingService : Service() {
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private lateinit var operatorName: String
    private lateinit var api: RelayApi
    private lateinit var notifications: NotificationManager
    private val seen = mutableSetOf<String>()
    private var lastHeartbeatAt = 0L

    override fun onCreate() {
        super.onCreate()
        operatorName = RelayConfig.operatorName(this)
        api = RelayApi(operatorName)
        notifications = getSystemService(NotificationManager::class.java)
        seen.addAll(getSharedPreferences(PREFERENCES, MODE_PRIVATE).getStringSet("seenTaskIds", emptySet()) ?: emptySet())
        notifications.createNotificationChannel(NotificationChannel(CHANNEL, "Oracle Relay", NotificationManager.IMPORTANCE_DEFAULT))
        startForeground(FOREGROUND_ID, statusNotification("等待 Relay 任务 · $operatorName"))
        executor.scheduleWithFixedDelay(::pollSafely, 0, 15, TimeUnit.SECONDS)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun pollSafely() {
        try {
            val tasks = api.listTasks()
            val preferences = getSharedPreferences(PREFERENCES, MODE_PRIVATE)
            tasks.forEach { task ->
                if (seen.add(task.id)) notifyTask(task)
            }
            preferences.edit().putStringSet("seenTaskIds", seen.toList().takeLast(500).toSet()).apply()

            val activeTaskId = preferences.getString("activeTaskId", null)
            val active = tasks.firstOrNull { it.id == activeTaskId }
            if (active != null && active.status in setOf("queued", "claimed", "awaiting-response")) {
                val now = System.currentTimeMillis()
                if (now - lastHeartbeatAt >= 45_000) {
                    api.heartbeat(active.id)
                    lastHeartbeatAt = now
                }
            } else if (activeTaskId != null && active == null) {
                preferences.edit().remove("activeTaskId").apply()
                lastHeartbeatAt = 0
            }
            notifications.notify(FOREGROUND_ID, statusNotification("已连接 · ${tasks.size} 个待处理任务 · $operatorName"))
        } catch (error: Exception) {
            notifications.notify(FOREGROUND_ID, statusNotification("连接失败 · ${error.message ?: "未知错误"}"))
        }
    }

    private fun notifyTask(task: RelayTask) {
        notifications.notify(task.id.hashCode(), android.app.Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("Oracle Relay 有新任务")
            .setContentText("${task.title} · ${task.attachments.size} 个附件")
            .setContentIntent(openAppIntent())
            .setAutoCancel(true)
            .build())
    }

    private fun statusNotification(text: String) = android.app.Notification.Builder(this, CHANNEL)
        .setSmallIcon(android.R.drawable.stat_notify_sync)
        .setContentTitle("Oracle Relay")
        .setContentText(text)
        .setContentIntent(openAppIntent())
        .setOngoing(true)
        .build()

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    companion object {
        internal const val PREFERENCES = "oracle-relay"
        private const val CHANNEL = "oracle-relay"
        private const val FOREGROUND_ID = 6142
    }
}
