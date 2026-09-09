package dev.slash.browser.downloads

import android.content.ContentValues
import android.content.Context
import android.provider.MediaStore
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

enum class DownloadState { QUEUED, RUNNING, COMPLETED, FAILED, CANCELLED }

/**
 * One transfer. **Immutable.**
 *
 * It was not, and that cost four attempts. The fields were `mutableStateOf`
 * delegates on a long-lived object, the download ran perfectly, the file arrived
 * in Downloads — and the row went on reading "Starting yt-dlp…" for ever, which
 * is indistinguishable from a transfer that hung. Each fix reasoned about which
 * observation Compose was missing, and each was wrong in a way nothing could
 * disprove: a list-wide `version` counter was added with a comment saying the
 * panel read it at the top, and the panel never read it at all.
 *
 * An immutable row removes the question rather than answering it. Recomposition
 * now follows from the identity of the list in [DownloadManager.downloads], which
 * changes on every mutation, and there is no per-object subscription left to get
 * wrong.
 */
data class Download(
    val id: String,
    val url: String,
    val title: String,
    val state: DownloadState,
    val detail: String,
    /** True when yt-dlp fetched it, so the row can say so. */
    val viaYtDlp: Boolean,
    val progress: Float = 0f,
    val bytes: Long = 0L,
    val totalBytes: Long = 0L,
    val savedAs: String? = null
)

/**
 * Downloads.
 *
 * Two paths, and which one is taken is decided by what the page is rather than
 * by the address:
 *
 *  - **A direct file** — a link to an `.mp4`, a PDF, an archive — is fetched
 *    here with a plain ranged request. Slash is the client; nothing is
 *    reassembled and nothing is decrypted.
 *  - **A video page** goes to yt-dlp, which is a separate public-domain program
 *    with its own extractors. Rows fetched that way are labelled **via yt-dlp**,
 *    so a download the browser could not make on its own never looks like one it
 *    did — the same rule the desktop applies to `adoptExternal`.
 *
 * Files land in the system Downloads collection through `MediaStore`, not in
 * app-private storage: a download somebody cannot find in their file manager has
 * not really arrived, and scoped storage means the app's own directory is
 * invisible to everything else.
 */
class DownloadManager(
    private val context: Context,
    private val ytDlp: YtDlpService,
    private val scope: CoroutineScope
) {
    /**
     * The whole list, replaced on every change.
     *
     * A single `State<List<Download>>` rather than a `SnapshotStateList` of
     * mutable rows. Reading this in a composable subscribes to *every* change to
     * *any* row, which is the property the previous design kept failing to have.
     */
    var downloads by mutableStateOf<List<Download>>(emptyList())
        private set

    var lastError by mutableStateOf<String?>(null)
        private set

    /** For marshalling yt-dlp's own progress thread onto the UI thread. */
    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    /** Running or queued, for the service's notification and the toolbar badge. */
    val activeCount: Int
        get() = downloads.count { it.state == DownloadState.RUNNING || it.state == DownloadState.QUEUED }

    /**
     * Replaces one row, on the main thread, by id.
     *
     * By id rather than by reference because the rows are values now: the object
     * a caller captured when it started the download is not the object in the
     * list a moment later. A row that has been cleared away simply does not
     * match, and the update is dropped rather than resurrecting it.
     */
    private fun edit(id: String, change: (Download) -> Download) {
        main.post {
            downloads = downloads.map { if (it.id == id) change(it) else it }
        }
    }

    private fun add(row: Download) {
        main.post { downloads = listOf(row) + downloads }
    }

    /**
     * Starts a video download for the page at [pageUrl].
     *
     * [formatId] null means "whatever yt-dlp thinks is best", which is the right
     * default for a tap that did not open the picker.
     */
    fun startVideo(pageUrl: String, title: String, formatId: String? = null) {
        val id = UUID.randomUUID().toString()
        add(
            Download(
                id = id,
                url = pageUrl,
                title = title.ifBlank { pageUrl },
                state = DownloadState.QUEUED,
                detail = "Preparing…",
                viaYtDlp = true
            )
        )

        scope.launch(Dispatchers.Main) {
            if (!ytDlp.ready) {
                edit(id) { it.copy(detail = "Starting yt-dlp…") }
                ytDlp.initialise()
            }
            if (!ytDlp.ready) {
                val reason = ytDlp.initError ?: "yt-dlp is not available on this device."
                edit(id) { it.copy(state = DownloadState.FAILED, detail = reason) }
                lastError = reason
                return@launch
            }

            edit(id) { it.copy(state = DownloadState.RUNNING) }
            val staging = File(context.cacheDir, "dl-$id")

            // yt-dlp reports from its own thread; `edit` hops to the main one.
            val result = ytDlp.download(pageUrl, formatId, staging, id) { progress, eta, line ->
                edit(id) { row ->
                    row.copy(
                        progress = (progress / 100f).coerceIn(0f, 1f),
                        detail = when {
                            progress <= 0f -> line.take(90).ifBlank { "Working…" }
                            eta > 0 -> "${progress.toInt()}% · ${eta}s left"
                            else -> "${progress.toInt()}%"
                        }
                    )
                }
            }

            result.fold(
                onSuccess = { file ->
                    edit(id) { it.copy(detail = "Saving…") }
                    val name = downloads.firstOrNull { it.id == id }?.title.orEmpty()
                    val published = publish(file, name)
                    staging.deleteRecursively()
                    if (published == null) {
                        edit(id) {
                            it.copy(
                                state = DownloadState.FAILED,
                                detail = "Downloaded, but could not be saved to your Downloads folder."
                            )
                        }
                    } else {
                        edit(id) {
                            it.copy(
                                state = DownloadState.COMPLETED,
                                savedAs = published,
                                progress = 1f,
                                detail = "Saved to Downloads"
                            )
                        }
                        Log.i(TAG, "completed $name -> $published")
                    }
                },
                onFailure = { error ->
                    staging.deleteRecursively()
                    val reason = readable(error)
                    edit(id) { it.copy(state = DownloadState.FAILED, detail = reason) }
                    lastError = reason
                    Log.w(TAG, "video download failed", error)
                }
            )
        }
    }

    /** A plain file, fetched by Slash itself. */
    fun startFile(url: String, suggestedName: String) {
        val id = UUID.randomUUID().toString()
        val title = suggestedName.ifBlank { url.substringAfterLast('/').ifBlank { "download" } }
        add(
            Download(
                id = id,
                url = url,
                title = title,
                state = DownloadState.QUEUED,
                detail = "Connecting…",
                viaYtDlp = false
            )
        )

        scope.launch(Dispatchers.Main) {
            edit(id) { it.copy(state = DownloadState.RUNNING) }
            val staging = File(context.cacheDir, "file-$id")
            try {
                withContext(Dispatchers.IO) {
                    val connection = (URL(url).openConnection() as HttpURLConnection).apply {
                        connectTimeout = 20_000
                        readTimeout = 60_000
                        setRequestProperty("Accept", "*/*")
                    }
                    try {
                        if (connection.responseCode !in 200..299) {
                            throw IllegalStateException("Server returned ${connection.responseCode}")
                        }
                        val total = connection.contentLengthLong.coerceAtLeast(0)
                        edit(id) { it.copy(totalBytes = total) }

                        connection.inputStream.use { input ->
                            staging.outputStream().use { output ->
                                val buffer = ByteArray(1 shl 16)
                                var received = 0L
                                // Progress is reported on a whole-chunk boundary
                                // rather than on every read: a 64 KB read on a
                                // fast connection happens hundreds of times a
                                // second, and each one now replaces the list.
                                var lastReport = 0L
                                while (true) {
                                    val read = input.read(buffer)
                                    if (read <= 0) break
                                    output.write(buffer, 0, read)
                                    received += read

                                    if (received - lastReport < REPORT_EVERY_BYTES) continue
                                    lastReport = received
                                    val snapshot = received
                                    edit(id) { row ->
                                        row.copy(
                                            bytes = snapshot,
                                            progress = if (total > 0) {
                                                (snapshot.toFloat() / total).coerceIn(0f, 1f)
                                            } else {
                                                0f
                                            },
                                            detail = if (total > 0) {
                                                "${(snapshot * 100 / total)}%"
                                            } else {
                                                "${snapshot / 1024} KB"
                                            }
                                        )
                                    }
                                }
                            }
                        }
                    } finally {
                        connection.disconnect()
                    }
                }

                val published = publish(staging, title)
                staging.delete()
                if (published == null) {
                    edit(id) {
                        it.copy(
                            state = DownloadState.FAILED,
                            detail = "Could not be saved to your Downloads folder."
                        )
                    }
                } else {
                    edit(id) {
                        it.copy(
                            state = DownloadState.COMPLETED,
                            savedAs = published,
                            progress = 1f,
                            detail = "Saved to Downloads"
                        )
                    }
                }
            } catch (error: Exception) {
                staging.delete()
                val reason = readable(error)
                edit(id) { it.copy(state = DownloadState.FAILED, detail = reason) }
                lastError = reason
                Log.w(TAG, "file download failed", error)
            }
        }
    }

    fun cancel(id: String) {
        val row = downloads.firstOrNull { it.id == id } ?: return
        if (row.viaYtDlp) ytDlp.cancel(id)
        edit(id) { it.copy(state = DownloadState.CANCELLED, detail = "Cancelled") }
    }

    fun clearFinished() {
        main.post {
            downloads = downloads.filterNot {
                it.state == DownloadState.COMPLETED ||
                    it.state == DownloadState.FAILED ||
                    it.state == DownloadState.CANCELLED
            }
        }
    }

    /**
     * Copies a finished file into the system Downloads collection.
     *
     * Returns the display name, or null. `MediaStore` rather than a path: on
     * Android 10 and later the app cannot write into shared storage directly,
     * and a file only the browser can see is not a download anybody can use.
     */
    private suspend fun publish(file: File, title: String): String? = withContext(Dispatchers.IO) {
        if (!file.exists() || file.length() == 0L) return@withContext null
        val name = sanitise(file.name.ifBlank { title })
        runCatching {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mimeFor(name))
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(
                MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
                values
            ) ?: return@runCatching null

            resolver.openOutputStream(uri)?.use { output ->
                file.inputStream().use { it.copyTo(output) }
            } ?: return@runCatching null

            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            name
        }.getOrElse {
            Log.w(TAG, "could not publish to MediaStore", it)
            null
        }
    }

    private companion object {
        const val TAG = "SlashDownloads"

        /** 256 KB between progress reports. See the loop above for why. */
        const val REPORT_EVERY_BYTES = 256L * 1024

        /**
         * A filename from the network is not a path.
         *
         * Reduced to a single component with no separators and no traversal,
         * the same rule `sanitiseFilename` encodes on the desktop. MediaStore
         * would reject most of this anyway, but a blocklist you rely on being
         * enforced elsewhere is a blocklist you are wrong about eventually.
         */
        fun sanitise(raw: String): String =
            raw.substringAfterLast('/')
                .substringAfterLast('\\')
                .replace(Regex("[^A-Za-z0-9._-]"), "_")
                .trim()
                .take(180)
                .ifBlank { "download" }

        fun mimeFor(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
            "mp4", "m4v" -> "video/mp4"
            "webm" -> "video/webm"
            "mkv" -> "video/x-matroska"
            "mp3" -> "audio/mpeg"
            "m4a" -> "audio/mp4"
            "pdf" -> "application/pdf"
            "zip" -> "application/zip"
            else -> "application/octet-stream"
        }

        fun readable(error: Throwable): String {
            val message = error.message.orEmpty()
            return when {
                message.contains("Unsupported URL", true) ->
                    "yt-dlp does not recognise this page as a video."
                message.contains("Sign in", true) || message.contains("login", true) ->
                    "This video needs an account, which Slash does not sign into for you."
                message.contains("DRM", true) ->
                    "This video is DRM-protected and cannot be downloaded."
                message.isBlank() -> "The download failed."
                else -> message.lineSequence().firstOrNull { it.isNotBlank() }?.take(160)
                    ?: "The download failed."
            }
        }
    }
}
