package com.dragonfsky.oraclerelay

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest

internal class RelayApi(private val operatorName: String) {
    fun listTasks(): List<RelayTask> {
        val array = JSONArray(request("GET", "/v1/tasks"))
        return buildList {
            for (index in 0 until array.length()) add(RelayTask.fromJson(array.getJSONObject(index)))
        }
    }

    fun getTask(taskId: String): RelayTask =
        RelayTask.fromJson(JSONObject(request("GET", "/v1/tasks/${escape(taskId)}")))

    fun claim(taskId: String): RelayTask = postOperator(taskId, "claim")

    fun markSubmitted(taskId: String): RelayTask = postOperator(taskId, "submitted")

    fun heartbeat(taskId: String): RelayTask = postOperator(taskId, "heartbeat")

    fun abort(taskId: String): RelayTask = postOperator(taskId, "abort")

    fun submitResponse(taskId: String, markdown: String, files: List<ResponseFile>): RelayTask {
        val attachments = JSONArray()
        files.forEach { file ->
            attachments.put(JSONObject()
                .put("filename", file.filename)
                .put("mimeType", file.mimeType)
                .put("contentBase64", Base64.encodeToString(file.bytes, Base64.NO_WRAP)))
        }
        val body = JSONObject()
            .put("operator", operatorName)
            .put("markdown", markdown)
            .put("attachments", attachments)
        return RelayTask.fromJson(JSONObject(request("POST", "/v1/tasks/${escape(taskId)}/response", body)))
    }

    fun downloadAttachment(taskId: String, attachment: RelayAttachment, destination: File) {
        if (destination.isFile && destination.length() == attachment.sizeBytes && sha256(destination) == attachment.sha256.lowercase()) {
            return
        }
        destination.parentFile?.mkdirs()
        val temporary = File(destination.parentFile, destination.name + ".part")
        val connection = open("GET", "/v1/tasks/${escape(taskId)}/attachments/${escape(attachment.id)}")
        try {
            checkSuccess(connection)
            val digest = MessageDigest.getInstance("SHA-256")
            connection.inputStream.use { input ->
                FileOutputStream(temporary).use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        digest.update(buffer, 0, count)
                        output.write(buffer, 0, count)
                    }
                }
            }
            require(temporary.length() == attachment.sizeBytes) { "附件大小校验失败：${attachment.filename}" }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            require(actual.equals(attachment.sha256, ignoreCase = true)) { "附件 SHA-256 校验失败：${attachment.filename}" }
            if (!temporary.renameTo(destination)) {
                temporary.copyTo(destination, overwrite = true)
                temporary.delete()
            }
        } finally {
            connection.disconnect()
            if (temporary.exists()) temporary.delete()
        }
    }

    private fun postOperator(taskId: String, action: String): RelayTask {
        val body = JSONObject().put("operator", operatorName)
        return RelayTask.fromJson(JSONObject(request("POST", "/v1/tasks/${escape(taskId)}/$action", body)))
    }

    private fun request(method: String, path: String, body: JSONObject? = null): String {
        val connection = open(method, path)
        try {
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            checkSuccess(connection)
            return connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    private fun open(method: String, path: String): HttpURLConnection =
        (URL(RelayConfig.URL.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 30_000
            readTimeout = 180_000
            useCaches = false
            setRequestProperty("Authorization", "Bearer ${RelayConfig.OPERATOR_TOKEN}")
            setRequestProperty("User-Agent", "OracleRelayOperator-Android/0.2.0")
        }

    private fun checkSuccess(connection: HttpURLConnection) {
        if (connection.responseCode in 200..299) return
        val message = connection.errorStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
        throw IllegalStateException("Relay 请求失败（${connection.responseCode}）：${message?.takeIf { it.isNotBlank() } ?: connection.responseMessage}")
    }

    private fun escape(value: String): String = URI(null, null, value, null).rawPath

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}

internal data class ResponseFile(val filename: String, val mimeType: String?, val bytes: ByteArray)
