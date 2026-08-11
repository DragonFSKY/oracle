plugins {
    id("com.android.application")
}

fun buildConfigString(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val relayUrl = providers.environmentVariable("ORACLE_RELAY_OPERATOR_URL").orElse("").get()
val operatorToken = providers.environmentVariable("ORACLE_RELAY_OPERATOR_TOKEN").orElse("").get()

android {
    namespace = "com.dragonfsky.oraclerelay"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.dragonfsky.oraclerelay"
        minSdk = 26
        targetSdk = 36
        versionCode = 3
        versionName = "0.2.1"

        buildConfigField("String", "RELAY_URL", buildConfigString(relayUrl))
        buildConfigField("String", "OPERATOR_TOKEN", buildConfigString(operatorToken))
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
}

dependencies {
    implementation("androidx.core:core:1.17.0")
}
