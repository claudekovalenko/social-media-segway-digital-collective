// "Your password" on the dashboard and admin pages: change your own password.
// Needs a normal sign-in (email or username + password); hidden otherwise.
(function () {
  const form = document.getElementById('changePassword');
  const fold = document.getElementById('passwordFold');
  const token = sessionStorage.getItem('dc_admin_token');
  if (!form || !fold || !token) return;
  fold.hidden = false;
  const base = typeof API_BASE === 'string' ? API_BASE : '';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mark = form.querySelector('.crm-saved');
    const f = new FormData(form);
    if (f.get('new_password') !== f.get('confirm')) { mark.textContent = 'The new passwords don’t match.'; return; }
    mark.textContent = '…';
    const res = await fetch(base + '/api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sessionStorage.getItem('dc_admin_token') },
      body: JSON.stringify({ current_password: f.get('current_password'), new_password: f.get('new_password') }),
    }).catch(() => null);
    const out = res ? await res.json().catch(() => ({})) : {};
    if (res && res.ok && out.token) {
      // The old sign-in stops working once the password changes; keep this one.
      sessionStorage.setItem('dc_admin_token', out.token);
      form.reset();
      mark.textContent = 'Password changed.';
    } else {
      mark.textContent = out.error || 'Could not change it. Try again.';
    }
  });
})();
