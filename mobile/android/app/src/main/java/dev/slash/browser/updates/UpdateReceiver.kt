package dev.slash.browser.updates

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log

/**
 * Where Android reports what happened to an install session.
 *
 * The interesting case is `STATUS_PENDING_USER_ACTION`: the system is asking to
 * show its own confirmation, and it hands back an Intent to launch. Ignoring it
 * means the install silently never happens — the session sits pending and the
 * user sees nothing at all, which is the failure mode this receiver exists for.
 */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -1)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = if (android.os.Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                }
                confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                runCatching { confirm?.let(context::startActivity) }
                    .onFailure { Log.w(TAG, "could not show the install prompt", it) }
            }
            PackageInstaller.STATUS_SUCCESS -> Log.i(TAG, "update installed")
            else -> Log.w(
                TAG,
                "install ended with status $status: " +
                    intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
            )
        }
    }

    private companion object {
        const val TAG = "SlashUpdates"
    }
}
