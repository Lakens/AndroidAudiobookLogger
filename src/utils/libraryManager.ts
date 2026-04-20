/**
 * libraryManager — persistent index of all audio files in the watched folder.
 *
 * Keeps one AsyncStorage entry ('library_tracks') with a TrackRecord per file.
 * Works from both the foreground (React components) and the background
 * AudioService (position saves, auto-advance).
 */
import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface TrackRecord {
  title: string;          // filename without extension — used as stable ID
  path: string;           // absolute FS path
  uri: string;            // file:// URI for TrackPlayer
  addedAt: string;        // ISO — when first discovered by scanFolder
  lastPlayedAt: string | null;
  positionSeconds: number;
  durationSeconds: number;
}

const KEY_LIBRARY = 'library_tracks';
const KEY_FOLDER  = 'library_folder_path';

export const DEFAULT_FOLDER =
  `${RNFS.ExternalStorageDirectoryPath}/OneDrive - TU Eindhoven/obsidian/09_audio_video_notes/pdf_audio_outputs`;

// In-memory cache so rapid UI updates don't hammer AsyncStorage
let _cache: TrackRecord[] | null = null;

// ── Sorting ────────────────────────────────────────────────────────────────

function activityTs(t: TrackRecord): number {
  const dates = [new Date(t.addedAt).getTime()];
  if (t.lastPlayedAt) dates.push(new Date(t.lastPlayedAt).getTime());
  return Math.max(...dates);
}

export function sortTracks(tracks: TrackRecord[]): TrackRecord[] {
  return [...tracks].sort((a, b) => activityTs(b) - activityTs(a));
}

// ── Persistence helpers ────────────────────────────────────────────────────

async function load(): Promise<TrackRecord[]> {
  if (_cache) return _cache;
  const raw = await AsyncStorage.getItem(KEY_LIBRARY);
  _cache = raw ? JSON.parse(raw) : [];
  return _cache!;
}

async function persist(tracks: TrackRecord[]): Promise<void> {
  _cache = tracks;
  await AsyncStorage.setItem(KEY_LIBRARY, JSON.stringify(tracks));
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function getFolderPath(): Promise<string> {
  return (await AsyncStorage.getItem(KEY_FOLDER)) ?? DEFAULT_FOLDER;
}

export async function setFolderPath(path: string): Promise<void> {
  await AsyncStorage.setItem(KEY_FOLDER, path);
  _cache = null; // force re-scan on next call
}

/** Scan the folder, merge with existing records, return sorted library. */
export async function scanFolder(folderPath: string): Promise<TrackRecord[]> {
  let existing = await load();
  const existingMap = new Map(existing.map(t => [t.title, t]));

  let dirItems: RNFS.ReadDirItem[] = [];
  try {
    dirItems = await RNFS.readDir(folderPath);
  } catch {
    // Folder missing or no permission — return stale library rather than crashing
    return sortTracks(existing);
  }

  const audioFiles = dirItems.filter(
    item => item.isFile() && /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i.test(item.name),
  );

  const now = new Date().toISOString();
  const onDiskTitles = new Set<string>();

  const merged: TrackRecord[] = audioFiles.map(item => {
    const title = item.name.replace(/\.[^.]+$/, '');
    onDiskTitles.add(title);
    const prev = existingMap.get(title);
    return prev
      ? { ...prev, path: item.path, uri: `file://${item.path}` } // refresh path
      : {
          title,
          path: item.path,
          uri: `file://${item.path}`,
          addedAt: now,
          lastPlayedAt: null,
          positionSeconds: 0,
          durationSeconds: 0,
        };
  });

  // Preserve records for files no longer on disk (so history isn't lost if
  // temporarily unmounted); mark them with a "missing" flag implicitly via
  // the fact that they won't appear in the scan result.
  // (We intentionally drop them — the queue should only show present files.)

  await persist(merged);
  return sortTracks(merged);
}

/** Return current library (cached) without re-scanning. */
export async function getLibrary(): Promise<TrackRecord[]> {
  return sortTracks(await load());
}

/** Most recently played track, or null if nothing has been played yet. */
export async function getLastPlayedTrack(): Promise<TrackRecord | null> {
  const tracks = await load();
  const played = tracks.filter(t => t.lastPlayedAt !== null);
  if (!played.length) return null;
  return played.reduce((a, b) =>
    new Date(a.lastPlayedAt!).getTime() > new Date(b.lastPlayedAt!).getTime() ? a : b,
  );
}

/** Next track in the sorted library after currentTitle, or null if at end. */
export async function getNextTrack(currentTitle: string): Promise<TrackRecord | null> {
  const sorted = sortTracks(await load());
  const idx = sorted.findIndex(t => t.title === currentTitle);
  if (idx === -1 || idx >= sorted.length - 1) return null;
  return sorted[idx + 1];
}

/** Update playback position (called frequently — avoids redundant writes via dirty flag). */
export async function savePosition(
  title: string,
  positionSeconds: number,
  durationSeconds?: number,
): Promise<void> {
  const tracks = await load();
  const idx = tracks.findIndex(t => t.title === title);
  if (idx === -1) return;

  const rec = tracks[idx];
  const newPos = Math.floor(positionSeconds);
  const newDur = durationSeconds && durationSeconds > 0
    ? Math.floor(durationSeconds)
    : rec.durationSeconds;
  const newLastPlayed = new Date().toISOString();

  // Skip write if nothing meaningful changed
  if (
    Math.abs(rec.positionSeconds - newPos) < 3 &&
    rec.durationSeconds === newDur &&
    rec.lastPlayedAt !== null
  ) return;

  tracks[idx] = { ...rec, positionSeconds: newPos, durationSeconds: newDur, lastPlayedAt: newLastPlayed };
  await persist(tracks);
}

/** Progress 0–100, or null if duration unknown. */
export function getProgress(track: TrackRecord): number | null {
  if (track.durationSeconds <= 0) return null;
  return Math.min(100, Math.round((track.positionSeconds / track.durationSeconds) * 100));
}

export function relativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const s = diff / 1000;
  if (s < 60)      return 'just now';
  if (s < 3600)    return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)   return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800)  return 'yesterday';
  if (s < 604800)  return `${Math.floor(s / 86400)}d ago`;
  return new Date(isoDate).toLocaleDateString();
}
