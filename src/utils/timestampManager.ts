import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { formatTime } from './formatTime';

export interface TimestampEntry {
  note_path: string;
  note_title: string;
  timestamp: string;
  seconds: number;
  logged_at: string;
  processed: boolean;
}

// Key used in AsyncStorage to cache the log path and pending queue
const KEY_LOG_PATH = 'timestamp_log_path';
const KEY_PENDING = 'pending_timestamps';

// Deduplicate: ignore marks within 2 seconds of an existing entry for the same track
const DEDUP_WINDOW_S = 2;

export async function getLogPath(): Promise<string | null> {
  return AsyncStorage.getItem(KEY_LOG_PATH);
}

export async function markTimestamp(
  trackTitle: string,
  positionSeconds: number,
): Promise<TimestampEntry | null> {
  const seconds = Math.floor(positionSeconds);

  // Dedup check
  const existing = await getEntriesForTrack(trackTitle);
  if (existing.some(e => Math.abs(e.seconds - seconds) < DEDUP_WINDOW_S)) {
    return null;
  }

  const entry: TimestampEntry = {
    note_path: `09_audio_video_notes/${trackTitle}.md`,
    note_title: trackTitle,
    timestamp: formatTime(seconds),
    seconds,
    logged_at: new Date().toISOString(),
    processed: false,
  };

  const logPath = await getLogPath();
  if (logPath) {
    try {
      await appendToLog(logPath, entry);
      return entry;
    } catch {
      // Fall through to pending queue if direct write fails
    }
  }
  await appendToPending(entry);
  return entry;
}

async function appendToLog(logPath: string, entry: TimestampEntry): Promise<void> {
  let log: TimestampEntry[] = [];
  if (await RNFS.exists(logPath)) {
    log = JSON.parse(await RNFS.readFile(logPath, 'utf8'));
  }
  log.push(entry);
  await RNFS.writeFile(logPath, JSON.stringify(log, null, 2), 'utf8');
}

async function appendToPending(entry: TimestampEntry): Promise<void> {
  const raw = await AsyncStorage.getItem(KEY_PENDING);
  const pending: TimestampEntry[] = raw ? JSON.parse(raw) : [];
  pending.push(entry);
  await AsyncStorage.setItem(KEY_PENDING, JSON.stringify(pending));
}

// Call when foregrounding or after saving a log path — drains the pending queue to disk
export async function flushPendingToLog(logPath: string): Promise<number> {
  const raw = await AsyncStorage.getItem(KEY_PENDING);
  if (!raw) return 0;
  const pending: TimestampEntry[] = JSON.parse(raw);
  if (pending.length === 0) return 0;

  let log: TimestampEntry[] = [];
  if (await RNFS.exists(logPath)) {
    log = JSON.parse(await RNFS.readFile(logPath, 'utf8'));
  }
  log.push(...pending);
  await RNFS.writeFile(logPath, JSON.stringify(log, null, 2), 'utf8');
  await AsyncStorage.removeItem(KEY_PENDING);
  return pending.length;
}

export async function getEntriesForTrack(trackTitle: string): Promise<TimestampEntry[]> {
  const notePath = `09_audio_video_notes/${trackTitle}.md`;
  const all: TimestampEntry[] = [];

  const logPath = await getLogPath();
  if (logPath && await RNFS.exists(logPath)) {
    const log: TimestampEntry[] = JSON.parse(await RNFS.readFile(logPath, 'utf8'));
    all.push(...log.filter(e => e.note_path === notePath));
  }

  // Also include any not-yet-flushed pending entries
  const raw = await AsyncStorage.getItem(KEY_PENDING);
  if (raw) {
    const pending: TimestampEntry[] = JSON.parse(raw);
    all.push(...pending.filter(e => e.note_path === notePath));
  }

  return all.sort((a, b) => a.seconds - b.seconds);
}

export async function getPendingCount(): Promise<number> {
  const raw = await AsyncStorage.getItem(KEY_PENDING);
  return raw ? JSON.parse(raw).length : 0;
}
