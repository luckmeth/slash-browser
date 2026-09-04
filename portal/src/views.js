/**
 * Server-rendered HTML.
 *
 * No build step and no client framework: this is a handful of forms and two
 * tables, and adding a bundler to it would be more machinery than the thing
 * itself. Everything a browser needs is in one file.
 */

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

export { escapeHtml }

const STYLE = `
  :root { color-scheme: dark; --bg:#0d0f14; --raised:#151922; --edge:#252b38;
          --text:#e6eaf3; --muted:#9aa5bb; --accent:#6ea8fe; --good:#58d39b;
          --bad:#f2777a; --warn:#e8b465; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { border-bottom:1px solid var(--edge); padding:14px 24px;
           display:flex; align-items:center; gap:16px; }
  header a { color:var(--muted); text-decoration:none; }
  header a:hover { color:var(--text); }
  .brand { font-weight:600; margin-right:auto; }
  main { max-width:900px; margin:0 auto; padding:28px 24px 60px; }
  h1 { font-size:22px; margin:0 0 6px; }
  h2 { font-size:15px; margin:28px 0 10px; }
  p.lede { color:var(--muted); margin:0 0 22px; }
  form { display:flex; flex-direction:column; gap:10px; max-width:520px; }
  label { display:block; font-size:12px; color:var(--muted); margin-bottom:4px; }
  input, textarea, select { width:100%; padding:8px 10px; border-radius:6px;
    border:1px solid var(--edge); background:var(--raised); color:var(--text);
    font:inherit; }
  textarea { min-height:70px; resize:vertical; }
  button { align-self:flex-start; padding:8px 14px; border-radius:6px; border:0;
    background:var(--accent); color:#08111f; font:inherit; font-weight:600;
    cursor:pointer; }
  button.secondary { background:transparent; border:1px solid var(--edge);
    color:var(--text); font-weight:400; }
  table { width:100%; border-collapse:collapse; margin-top:8px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--edge);
    font-size:13px; vertical-align:top; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px;
    font-size:11px; border:1px solid var(--edge); }
  .pending { color:var(--warn); } .approved { color:var(--good); }
  .rejected { color:var(--bad); }
  .note { color:var(--muted); font-size:12px; }
  .error { color:var(--bad); }
  .card { border:1px solid var(--edge); border-radius:10px; padding:16px;
    background:var(--raised); margin-bottom:14px; }
  img.creative { width:48px; height:48px; border-radius:8px; object-fit:cover; }
  code { background:#1c2230; padding:1px 5px; border-radius:4px; font-size:12px; }
`

export function page({ title, company, body }) {
  const nav = company
    ? `<a href="/dashboard">Campaigns</a>
       ${company.is_admin ? '<a href="/admin">Review queue</a>' : ''}
       <span class="note">${escapeHtml(company.email)}</span>
       <form method="post" action="/logout" style="display:inline">
         <button class="secondary" type="submit">Sign out</button>
       </form>`
    : `<a href="/login">Sign in</a><a href="/signup">Create an account</a>`

  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Slash sponsors</title>
  <style>${STYLE}</style>
</head><body>
  <header><span class="brand">Slash sponsors</span>${nav}</header>
  <main>${body}</main>
</body></html>`
}

export function landing() {
  return `
    <h1>Advertise on the Slash start page</h1>
    <p class="lede">One clearly-labelled tile, shown to people who open a new tab.</p>
    <div class="card">
      <h2 style="margin-top:0">How it works, and what it does not do</h2>
      <p class="note">
        Slash downloads a batch of adverts every few hours and picks one on the reader's own
        machine. It sends no browsing data, no page address and no identifier — so you can be
        told how many times a creative was shown and clicked, per day, and nothing more than
        that. There is no targeting, because there is nothing to target with.
      </p>
      <p class="note">
        Creatives are stored on the reader's machine, so showing your advert makes no request to
        you at all. Images must therefore be uploaded here rather than hot-linked.
      </p>
    </div>
    <p><a href="/signup"><button>Create an account</button></a></p>`
}

export function authForm({ mode, error }) {
  const isSignup = mode === 'signup'
  return `
    <h1>${isSignup ? 'Create an account' : 'Sign in'}</h1>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/${isSignup ? 'signup' : 'login'}">
      ${isSignup ? '<div><label for="name">Company name</label><input id="name" name="name" required maxlength="120"></div>' : ''}
      <div><label for="email">Email</label><input id="email" name="email" type="email" required></div>
      <div><label for="password">Password</label><input id="password" name="password" type="password" required minlength="8"></div>
      <button type="submit">${isSignup ? 'Create account' : 'Sign in'}</button>
    </form>
    <p class="note" style="margin-top:14px">
      ${isSignup ? 'Already registered? <a href="/login">Sign in</a>.' : 'No account yet? <a href="/signup">Create one</a>.'}
    </p>`
}

export function dashboard({ company, campaigns, totals, error }) {
  const rows = campaigns.length
    ? campaigns
        .map((campaign) => {
          const stat = totals.get(campaign.id) ?? { impressions: 0, clicks: 0 }
          return `<tr>
            <td>${campaign.image ? `<img class="creative" src="${escapeHtml(campaign.image)}" alt="">` : ''}</td>
            <td>
              <strong>${escapeHtml(campaign.headline)}</strong><br>
              <span class="note">${escapeHtml(campaign.name)}</span>
              ${campaign.note ? `<br><span class="note rejected">${escapeHtml(campaign.note)}</span>` : ''}
            </td>
            <td><span class="pill ${campaign.status}">${campaign.status}</span></td>
            <td>${stat.impressions.toLocaleString()}</td>
            <td>${stat.clicks.toLocaleString()}</td>
          </tr>`
        })
        .join('')
    : `<tr><td colspan="5" class="note">No campaigns yet.</td></tr>`

  return `
    <h1>Your campaigns</h1>
    <p class="lede">${escapeHtml(company.name)}</p>
    <table>
      <tr><th></th><th>Campaign</th><th>Status</th><th>Shown</th><th>Clicks</th></tr>
      ${rows}
    </table>

    <h2>Submit a new campaign</h2>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/campaigns" id="campaign-form">
      <div><label for="cname">Internal name</label><input id="cname" name="name" required maxlength="120"></div>
      <div><label for="headline">Headline</label><input id="headline" name="headline" required maxlength="200"></div>
      <div><label for="body">Supporting line (optional)</label><textarea id="body" name="body" maxlength="400"></textarea></div>
      <div><label for="click">Landing page (https only)</label><input id="click" name="clickUrl" type="url" required placeholder="https://example.com/offer"></div>
      <div>
        <label for="image">Image (optional, under 500&nbsp;KB)</label>
        <input id="image" type="file" accept="image/png,image/jpeg,image/webp">
        <input type="hidden" name="image" id="image-data">
        <p class="note" id="image-note">Stored with the advert and delivered to readers' machines, so it never loads from your server.</p>
      </div>
      <button type="submit">Submit for review</button>
    </form>

    <script>
      // Read the file here and post it as a data URL. The browser refuses any
      // creative whose image is remote, so there is no point storing a link.
      const picker = document.getElementById('image');
      const hidden = document.getElementById('image-data');
      const note = document.getElementById('image-note');
      picker.addEventListener('change', () => {
        const file = picker.files && picker.files[0];
        if (!file) { hidden.value = ''; return; }
        if (file.size > 500 * 1024) {
          note.textContent = 'That image is over 500 KB. Please choose a smaller one.';
          note.className = 'note error';
          picker.value = ''; hidden.value = '';
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          hidden.value = String(reader.result || '');
          note.textContent = 'Ready: ' + Math.round(file.size / 1024) + ' KB';
          note.className = 'note';
        };
        reader.readAsDataURL(file);
      });
    </script>`
}

export function adminQueue({ pending, recent }) {
  const row = (campaign, actions) => `<tr>
    <td>${campaign.image ? `<img class="creative" src="${escapeHtml(campaign.image)}" alt="">` : ''}</td>
    <td>
      <strong>${escapeHtml(campaign.headline)}</strong><br>
      <span class="note">${escapeHtml(campaign.body || '')}</span><br>
      <span class="note">${escapeHtml(campaign.company_name)} → <code>${escapeHtml(campaign.click_url)}</code></span>
    </td>
    <td>${actions}</td>
  </tr>`

  const pendingRows = pending.length
    ? pending
        .map((campaign) =>
          row(
            campaign,
            `<form method="post" action="/admin/${campaign.id}/decide">
               <input name="note" placeholder="Reason, if rejecting" style="margin-bottom:6px">
               <div style="display:flex; gap:6px">
                 <button name="decision" value="approved" type="submit">Approve</button>
                 <button class="secondary" name="decision" value="rejected" type="submit">Reject</button>
               </div>
             </form>`
          )
        )
        .join('')
    : `<tr><td colspan="3" class="note">Nothing waiting.</td></tr>`

  const recentRows = recent.length
    ? recent
        .map(
          (campaign) =>
            `<tr><td>${escapeHtml(campaign.headline)}</td>
             <td><span class="pill ${campaign.status}">${campaign.status}</span></td>
             <td class="note">${escapeHtml(campaign.company_name)}</td></tr>`
        )
        .join('')
    : `<tr><td colspan="3" class="note">Nothing reviewed yet.</td></tr>`

  return `
    <h1>Review queue</h1>
    <p class="lede">Approved campaigns are served to every copy of Slash pointed at this portal.</p>
    <table><tr><th></th><th>Campaign</th><th>Decision</th></tr>${pendingRows}</table>
    <h2>Recently reviewed</h2>
    <table><tr><th>Headline</th><th>Status</th><th>Company</th></tr>${recentRows}</table>`
}
