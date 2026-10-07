// Google Drive expects multipart/related, not FormData's multipart/form-data.
export function buildDriveUpload(blob, filename, boundary = `noted_${crypto.randomUUID()}`) {
  const metadata = JSON.stringify({ name: filename, mimeType: blob.type || 'application/octet-stream' });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
    blob, `\r\n--${boundary}--\r\n`,
  ], { type: `multipart/related; boundary=${boundary}` });
  return { body, contentType: body.type };
}

export async function uploadToDrive(blob, filename, accessToken) {
  const { body, contentType } = buildDriveUpload(blob, filename);
  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': contentType }, body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(response.status === 401
      ? 'Google authorization expired. Click Export again to reconnect.'
      : `Google Drive upload failed (${response.status}): ${data.error?.message || response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
