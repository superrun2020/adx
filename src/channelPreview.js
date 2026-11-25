const previewParam = 'channelPreview';

export function previewUserId() {
  return new URLSearchParams(globalThis.window?.location?.search).get(previewParam);
}

export function previewPagePath(path, userId = previewUserId()) {
  return userId === null ? path : path + '?' + new URLSearchParams({ [previewParam]:userId });
}

export function previewApiPath(path) {
  const id = previewUserId();
  return id !== null && path.startsWith('/api/') ? '/api/admin/channel-preview/' + encodeURIComponent(id || 'invalid') + path : path;
}
