const reauthKey = 'adx_session_reauth';
let redirecting = false;

// A stale tab can outlive its session. Return to the login screen once instead
// of letting every report display its own "unauthorized" error.
export async function sessionFetch(path, options) {
  const response = await fetch(path, options);
  if (response.status !== 401) return response;
  if (!redirecting) {
    redirecting = true;
    try { sessionStorage.setItem(reauthKey, '1'); } catch { /* Private mode may block storage. */ }
    window.location.reload();
  }
  // The document is navigating; do not deliver an obsolete response to a view.
  return new Promise(() => {});
}
