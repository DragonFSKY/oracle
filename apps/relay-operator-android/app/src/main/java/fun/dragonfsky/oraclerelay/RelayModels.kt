package com.dragonfsky.oraclerelay

import android.content.Context
import android.os.Build
import android.provider.Settings
import org.json.JSONObject

internal object RelayConfig {
    const val URL = BuildConfig.RELAY_URL
    const val OPERATOR_TOKEN = BuildConfig.OPERATOR_TOKEN

    fun operatorName(context: Context): String {
        val androidId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
            ?.takeLast(8)
            ?: "device"
        val model = Build.MODEL.replace(Regex("[^A-Za-z0-9_-]+"), "-").trim('-').take(50)
        return "android-${model.ifBlank { "device" }}-$androidId"
    }
}

internal data class RelayAttachment(
    val id: String,
    val filename: String,
    val displayPath: String,
    val mimeType: String?,
    val sizeBytes: Long,
    val sha256: String,
    val direction: String,
) {
    companion object {
        fun fromJson(json: JSONObject) = RelayAttachment(
            id = json.getString("id"),
            filename = json.getString("filename"),
            displayPath = json.optString("displayPath", json.getString("filename")),
            mimeType = json.optNullableString("mimeType"),
            sizeBytes = json.getLong("sizeBytes"),
            sha256 = json.getString("sha256"),
            direction = json.optString("direction", "request"),
        )
    }
}

internal data class RelayTask(
    val id: String,
    val status: String,
    val title: String,
    val prompt: String,
    val modelHint: String?,
    val claimedBy: String?,
    val attachments: List<RelayAttachment>,
) {
    companion object {
        fun fromJson(json: JSONObject): RelayTask {
            val array = json.optJSONArray("attachments")
            val attachments = buildList {
                if (array != null) {
                    for (index in 0 until array.length()) add(RelayAttachment.fromJson(array.getJSONObject(index)))
                }
            }
            return RelayTask(
                id = json.getString("id"),
                status = json.getString("status"),
                title = json.optString("title", "Relay task"),
                prompt = json.optString("prompt", ""),
                modelHint = json.optNullableString("modelHint"),
                claimedBy = json.optNullableString("claimedBy"),
                attachments = attachments,
            )
        }
    }
}

private fun JSONObject.optNullableString(name: String): String? =
    if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }
