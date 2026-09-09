plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.slash.browser"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.slash.browser"
        // 26 rather than 21: the shell leans on androidx.webkit features whose
        // real floor is the *WebView* version, not the SDK level, and 26 is where
        // the OS-side APIs the browser needs (notification channels, adaptive
        // icons, background execution limits) stop needing two code paths.
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        // A debug-signed release build. Real distribution needs a keystore that
        // is backed up before the first release — lose it and no existing
        // install can ever update again, which is Android's one unforgiving
        // difference from the unsigned desktop build.
        create("slash") {
            storeFile = file("${System.getProperty("user.home")}/.android/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("slash")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            signingConfig = signingConfigs.getByName("slash")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"

        // Required by youtubedl-android, and the reason yt-dlp failed to start
        // with "failed to initialize / ENOENT" while every ABI was present in
        // the APK: it ships the Python runtime *inside* .so files and unpacks
        // them from disk at first use. Modern Gradle maps native libraries
        // straight out of the (compressed) APK and never writes them out, so
        // there was nothing on disk to open. Legacy packaging extracts them at
        // install time, which is what this library needs.
        jniLibs.useLegacyPackaging = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")

    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    // Profile, addDocumentStartJavaScript and addWebMessageListener are all
    // androidx.webkit, not framework WebView. The whole shell rests on this.
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    // scrypt. Android's JCA has no provider for it, and the sync key must be
    // derived with exactly the desktop's parameters or the two platforms cannot
    // read each other's data. A pure-JVM jar, so none of the node-gyp/NDK
    // constraints in CLAUDE.md apply.
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")

    // yt-dlp, via the maintained Android port (a bundled Python runtime).
    implementation("io.github.junkfood02.youtubedl-android:library:0.17.4")
    implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.17.4")

    // Keystore-backed storage for the rewards refresh token — the platform
    // equivalent of the desktop's safeStorage. As there, no secure store means
    // no sign-in rather than a readable fallback.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
}
