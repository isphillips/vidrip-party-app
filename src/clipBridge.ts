// The game's "Your best face" clip, handed to the phone (the web view can't give a video file to the share sheet or the
// photo gallery). The page posts the finished clip as base64 in chunks, then asks to save or share it:
//
//   page → app  { t: 'clipChunk', id, i, n, b64 }                                   chunk i of n (concatenated base64)
//   page → app  { t: 'clipDone',  id, n, name, mime, mode: 'save' | 'share', text }  all chunks sent: do it
//   app → page  window.__clipResult({ id, ok, error? })                              the outcome (the page counts clip_saved / clip_shared only on ok)
//
// The clip lives in this app's cache folder only for as long as that takes, and is deleted afterwards. Nothing is sent
// to Vidrip: Share hands the file to the player's own share sheet, Save puts it in their Photos / Movies.
import { PermissionsAndroid, Platform } from 'react-native';
import Share from 'react-native-share';
import { CameraRoll } from '@react-native-camera-roll/camera-roll';
import NitroFS from 'react-native-nitro-fs';

export type ClipMsg = { t?: string; id?: string; i?: number; n?: number; b64?: string; name?: string; mime?: string; mode?: string; text?: string };
export type ClipResult = { id: string; ok: boolean; error?: string };

const MAX_B64 = 48 * 1024 * 1024;   // a clip is 2-3 MB; refuse anything absurd
const pending = new Map<string, { parts: string[]; got: number; size: number; at: number }>();

function sweep(): void {
  const now = Date.now();
  for (const [id, p] of pending) { if (now - p.at > 120000) { pending.delete(id); } }
}

/** One 'clipChunk' or 'clipDone' message. Resolves with a result to send back to the page, or null (more chunks to come). */
export async function onClipMessage(m: ClipMsg): Promise<ClipResult | null> {
  sweep();
  const id = typeof m.id === 'string' ? m.id.slice(0, 40) : '';
  if (!id) { return null; }
  if (m.t === 'clipChunk') {
    const n = Number(m.n), i = Number(m.i);
    if (!Number.isInteger(n) || !Number.isInteger(i) || n < 1 || n > 400 || i < 0 || i >= n || typeof m.b64 !== 'string') { return { id, ok: false, error: 'bad chunk' }; }
    const p = pending.get(id) ?? { parts: new Array<string>(n).fill(''), got: 0, size: 0, at: Date.now() };
    if (p.parts.length !== n) { pending.delete(id); return { id, ok: false, error: 'bad chunk' }; }
    if (!p.parts[i]) { p.got += 1; }
    p.size += m.b64.length - p.parts[i].length; p.parts[i] = m.b64; p.at = Date.now();
    if (p.size > MAX_B64) { pending.delete(id); return { id, ok: false, error: 'clip too large' }; }
    pending.set(id, p);
    return null;
  }
  if (m.t !== 'clipDone') { return null; }
  const p = pending.get(id); pending.delete(id);
  if (!p || p.got !== p.parts.length || Number(m.n) !== p.parts.length) { return { id, ok: false, error: 'clip incomplete' }; }
  const mime = m.mime === 'video/webm' ? 'video/webm' : 'video/mp4';
  const ext = mime === 'video/webm' ? 'webm' : 'mp4';
  const base = String(m.name ?? 'vidrip-party-best-face').replace(/[^A-Za-z0-9._-]/g, '').replace(/\.(mp4|webm)$/i, '').slice(0, 60) || 'vidrip-party-best-face';
  const dir = `${NitroFS.CACHE_DIR}/vidrip-party-clips`;
  const path = `${dir}/${base}-${Date.now()}.${ext}`;
  try {
    await NitroFS.writeFile(path, p.parts.join(''), 'base64');
    if (m.mode === 'save') { await saveToGallery(path); }
    else { await shareFile(path, mime, typeof m.text === 'string' ? m.text.slice(0, 280) : ''); }
    return { id, ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Closing the share sheet without choosing anything is not an error.
    if (/cancel|dismiss/i.test(msg)) { return { id, ok: false, error: 'cancelled' }; }
    return { id, ok: false, error: msg.slice(0, 120) };
  } finally {
    NitroFS.unlink(path).catch(() => { /* already gone */ });
  }
}

async function shareFile(path: string, mime: string, text: string): Promise<void> {
  await Share.open({ url: `file://${path}`, type: mime, message: text, title: 'Vidrip Party', failOnCancel: true });
}

async function saveToGallery(path: string): Promise<void> {
  // Android 10+ saves through MediaStore with no permission; Android 8 and 9 (minSdk is 26) need the storage permission.
  if (Platform.OS === 'android' && Number(Platform.Version) < 29) {
    const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
    if (r !== PermissionsAndroid.RESULTS.GRANTED) { throw new Error('permission denied'); }
  }
  // iOS asks for "add only" access to Photos (NSPhotoLibraryAddUsageDescription). The album name is Android-only: on iOS an
  // album needs read access, which this app never asks for.
  await CameraRoll.saveAsset(`file://${path}`, { type: 'video', ...(Platform.OS === 'android' ? { album: 'Vidrip Party' } : {}) });
}
