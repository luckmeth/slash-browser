package dev.slash.browser.downloads

import android.content.Context
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import com.yausername.ffmpeg.FFmpeg
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

data class MediaFormat(
    val id: String,
    val label: String,
    val extension: String,
    val height: Int,
    val filesize: Long
)

/**
 * yt-dlp, on Android.
 *
 * The desktop refuses to bundle yt-dlp, and the reason it gives is specific:
 * releases carry extractor fixes every few weeks, **Slash has no auto-update
 * because it is unsigned**, so a copy frozen into the installer breaks within a
 * month and cannot be repaired short of reinstalling 188 MB.
 *
 * Neither half of that holds here. Android signing is a free self-signed
 * keystore, so Slash *does* update itself — and this port exposes
 * `YoutubeDL.updateYoutubeDL`, which replaces the Python payload in place
 * without touching the APK. A stale extractor is therefore a one-tap fix rather
 * than a reinstall, which is exactly the objection that made bundling wrong on
 * the desktop.
 *
 * What has not changed: **Slash does not defeat access controls itself.** The
 * capability lives in yt-dlp, a separate public-domain program, and anything it
 * fetches is labelled as having come from it — so a download the browser could
 * not make on its own never looks like one it did.
 *
 * The cost is honest and large: the bundled Python runtime is most of this
 * app's size, and this is why the build is sideload-only. Play's Device and
 * Network Abuse policy prohibits it, which is why NewPipe and Seal are not there
 * either.
 */
class YtDlpService(private val context: Context) {

    var ready by mutableStateOf(false)
        private set

    var initError by mutableStateOf<String?>(null)
        private set

    var version by mutableStateOf<String?>(null)
        private set

    /**
     * Loads the runtime.
     *
     * Slow the first time — it unpacks Python — so it happens off the browsing
     * path and failure is a state rather than a crash. A device that cannot run
     * it still browses; it simply cannot offer this.
     */
    suspend fun initialise() = withContext(Dispatchers.IO) {
        if (ready) return@withContext
        try {
            YoutubeDL.getInstance().init(context)
            runCatching { FFmpeg.getInstance().init(context) }
                .onFailure { Log.w(TAG, "ffmpeg unavailable; merged formats will not work", it) }
            version = runCatching { YoutubeDL.getInstance().version(context) }.getOrNull()
            ready = true
            initError = null
            Log.i(TAG, "yt-dlp ready (${version ?: "version unknown"})")
        } catch (error: Exception) {
            initError = error.message ?: "yt-dlp could not start on this device."
            Log.e(TAG, "yt-dlp init failed", error)
        }
    }

    /**
     * Updates the extractors without touching the APK.
     *
     * The whole reason bundling is defensible here rather than on the desktop.
     */
    suspend fun update(): Result<String> = withContext(Dispatchers.IO) {
        if (!ready) return@withContext Result.failure(IllegalStateException("yt-dlp is not ready."))
        runCatching {
            YoutubeDL.getInstance().updateYoutubeDL(context)
            version = YoutubeDL.getInstance().version(context)
            version ?: "updated"
        }
    }

    /** What this page offers, newest-first by quality. */
    suspend fun formats(url: String): Result<List<MediaFormat>> = withContext(Dispatchers.IO) {
        if (!ready) return@withContext Result.failure(IllegalStateException("yt-dlp is not ready."))
        runCatching {
            val info = YoutubeDL.getInstance().getInfo(url)
            val rows = info.formats.orEmpty().mapNotNull { format ->
                val id = format.formatId ?: return@mapNotNull null
                // Audio-only and storyboard entries are real formats and not
                // what somebody tapping "download" means, so they are left out
                // rather than listed and then explained.
                val height = format.height
                if (height <= 0) return@mapNotNull null
                MediaFormat(
                    id = id,
                    label = "${height}p",
                    extension = format.ext ?: "mp4",
                    height = height,
                    filesize = format.fileSize.takeIf { it > 0 } ?: 0L
                )
            }
            // One row per height. yt-dlp lists several encodings of the same
            // resolution and a picker with four "1080p" rows asks the user a
            // question they cannot answer.
            rows.groupBy { it.height }
                .map { (_, group) -> group.maxByOrNull { it.filesize } ?: group.first() }
                .sortedByDescending { it.height }
        }
    }

    /**
     * Downloads one format into [into].
     *
     * `onProgress` is called on yt-dlp's own thread; callers hop to wherever
     * they need before touching UI state.
     */
    suspend fun download(
        url: String,
        formatId: String?,
        into: File,
        id: String,
        onProgress: (Float, Long, String) -> Unit
    ): Result<File> = withContext(Dispatchers.IO) {
        if (!ready) return@withContext Result.failure(IllegalStateException("yt-dlp is not ready."))
        runCatching {
            into.mkdirs()
            val request = YoutubeDLRequest(url).apply {
                addOption("-o", File(into, "%(title)s.%(ext)s").absolutePath)
                addOption("--no-mtime")
                // Restrict filenames: a title from the network is not a path,
                // and this is the same reasoning `sanitiseFilename` encodes on
                // the desktop — except here yt-dlp owns the naming, so it is
                // told to be conservative rather than trusted to be.
                addOption("--restrict-filenames")
                if (formatId != null) {
                    // The chosen video plus the best audio, muxed by ffmpeg.
                    addOption("-f", "$formatId+bestaudio/$formatId")
                }
                // No selector otherwise. `-f best` picks the best *pre-merged*
                // stream, which on most sites is markedly worse than the best
                // video muxed to the best audio — yt-dlp warns about exactly
                // this, and the warning was in our own logs. Passing nothing
                // lets it choose, which is what it is for.
            }
            YoutubeDL.getInstance().execute(request, id) { progress, etaSeconds, line ->
                onProgress(progress, etaSeconds, line)
            }
            // yt-dlp names the file itself, so the newest one in the folder is
            // the one it just wrote.
            into.listFiles()?.maxByOrNull { it.lastModified() }
                ?: throw IllegalStateException("yt-dlp reported success but wrote no file.")
        }
    }

    fun cancel(id: String) {
        runCatching { YoutubeDL.getInstance().destroyProcessById(id) }
    }

    private companion object {
        const val TAG = "SlashYtDlp"
    }
}
