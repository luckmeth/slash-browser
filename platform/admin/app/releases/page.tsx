import { redirect } from 'next/navigation'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'
import { PullButton, ReleaseForm } from '@/components/ReleaseForm'

export const dynamic = 'force-dynamic'

export default async function ReleasesPage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const { data } = await supabaseService()
    .from('releases')
    .select('id, version, release_url, notes, channel, published, published_at, created_at')
    .order('created_at', { ascending: false })
    .limit(40)

  const releases = data ?? []
  const live = releases.filter((release) => release.published)

  return (
    <main>
      <h1>Releases</h1>
      <p className="lede">
        What the browser&rsquo;s update check reads. Exactly one release per channel is served — the
        newest published one.
      </p>

      <div className="card" style={{ borderColor: 'var(--warn)' }}>
        <h3 style={{ marginTop: 0 }}>Point the browser here first</h3>
        <p className="note">
          In Slash: <strong>Settings → About Slash → Updates</strong>, set the release feed to
          <code> https://ads.yourdomain.com/api/updates/latest</code>. Empty by default, which is why
          a fresh install never contacts anything.
        </p>
        <p className="note">
          Publishing here tells people a version exists and links them to it. It does{' '}
          <strong>not</strong> install anything: this build is not code-signed, so it cannot verify
          an update came from you. Buy a certificate and the browser starts offering to install.
        </p>
      </div>

      {live.length === 0 ? (
        <p className="note" style={{ marginTop: 16 }}>
          Nothing published. The feed returns 404 and browsers report that they could not reach it.
        </p>
      ) : (
        <div className="grid" style={{ marginTop: 16 }}>
          {live.map((release) => (
            <div className="card" key={release.id}>
              <div className="note">{release.channel} · being served now</div>
              <div className="hero-cost">{release.version}</div>
              <p className="note" style={{ wordBreak: 'break-all' }}>{release.release_url}</p>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <ReleaseForm />
      </div>

      <h2>Everything published</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Channel</th>
              <th>Status</th>
              <th>When</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {releases.length === 0 ? (
              <tr>
                <td colSpan={5} className="note">
                  Nothing yet.
                </td>
              </tr>
            ) : (
              releases.map((release) => (
                <tr key={release.id}>
                  <td>{release.version}</td>
                  <td className="note">{release.channel}</td>
                  <td>
                    <span className={`pill ${release.published ? 'active' : 'rejected'}`}>
                      {release.published ? 'serving' : 'pulled'}
                    </span>
                  </td>
                  <td className="note">
                    {release.published_at
                      ? new Date(release.published_at).toLocaleString()
                      : new Date(release.created_at).toLocaleString()}
                  </td>
                  <td>{release.published && <PullButton id={release.id} />}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  )
}
