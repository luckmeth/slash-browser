// Versions are pinned to what is already in the local Gradle cache so a first
// build does not turn into a twenty-minute download. See mobile/README.md.
plugins {
    id("com.android.application") version "8.13.1" apply false
    id("org.jetbrains.kotlin.android") version "2.2.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.20" apply false
}
