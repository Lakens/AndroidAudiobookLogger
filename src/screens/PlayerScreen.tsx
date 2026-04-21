import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  AppStateStatus,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { pick, types, isErrorWithCode, errorCodes } from '@react-native-documents/picker';
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  Event,
  State,
  usePlaybackState,
  useProgress,
  useTrackPlayerEvents,
} from 'react-native-track-player';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import { formatTime } from '../utils/formatTime';
import { getLastPlayedTrack, savePosition as libSavePosition } from '../utils/libraryManager';
import {
  flushPendingToLog as tsFlush,
  getEntriesForTrack as tsGetEntries,
  getLogPath as tsGetLogPath,
  markTimestamp as tsMark,
  TimestampEntry,
} from '../utils/timestampManager';
import type { RootStackParamList } from '../../App';

const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2];
// Save position to library every N seconds while playing
const SAVE_INTERVAL_MS = 10_000;

type Props = NativeStackScreenProps<RootStackParamList, 'Player'>;

// Module-level flag — survives component re-mounts caused by navigation.
// useRef resets on every new component instance; this does not.
let _playerInitialized = false;

export default function PlayerScreen({ route }: Props) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { state: playbackState } = usePlaybackState();
  const { position, duration } = useProgress(300);

  const [trackTitle, setTrackTitle] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);
  const [timestamps, setTimestamps] = useState<TimestampEntry[]>([]);
  const [lastMarked, setLastMarked] = useState<string | null>(null);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);

  const pendingSeekRef = useRef(0);
  const saveTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentTitle   = useRef<string | null>(null);

  // ── Player setup (once per app session) ───────────────────────────────────
  useEffect(() => {
    if (_playerInitialized) return;
    _playerInitialized = true;

    // Catch player_already_initialized in case the service restarted before us
    const setup = TrackPlayer.setupPlayer({ autoHandleInterruptions: true })
      .catch((e: any) => {
        if (e?.code === 'player_already_initialized') return;
        throw e;
      });

    setup.then(async () => {
      // Ensure options are always set even if AudioService background task ran early
      await TrackPlayer.updateOptions({
        android: {
          appKilledPlaybackBehavior:
            AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
        },
        capabilities: [
          Capability.Play, Capability.Pause, Capability.SeekTo,
          Capability.JumpForward, Capability.JumpBackward,
          Capability.SkipToPrevious, Capability.SkipToNext,
        ],
        compactCapabilities: [Capability.Play, Capability.Pause, Capability.JumpForward],
        notificationCapabilities: [
          Capability.SkipToPrevious, Capability.JumpBackward,
          Capability.Play, Capability.Pause,
          Capability.JumpForward, Capability.SkipToNext,
        ],
        forwardJumpInterval: 30,
        backwardJumpInterval: 30,
      });

      if (route.params) {
        // Opened from Library with explicit track
        const { trackTitle: t, trackUri: u, startPosition: sp } = route.params;
        await loadTrack(t, u, sp);
      } else {
        // No params — restore last played from library (or last cached title/uri)
        const lp = await getLastPlayedTrack();
        if (lp) {
          await loadTrack(lp.title, lp.uri, lp.positionSeconds);
        } else {
          const [t, u] = await Promise.all([
            AsyncStorage.getItem('last_track_title'),
            AsyncStorage.getItem('last_track_uri'),
          ]);
          if (t && u) await loadTrack(t, u, 0);
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reload if navigation params change (user picked a new file in Library) ─
  useEffect(() => {
    if (!route.params || !_playerInitialized) return;
    const { trackTitle: t, trackUri: u, startPosition: sp } = route.params;
    if (t !== currentTitle.current) {
      loadTrack(t, u, sp);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params]);

  // ── Periodic position save while playing ──────────────────────────────────
  useEffect(() => {
    if (playbackState === State.Playing) {
      saveTimerRef.current = setInterval(async () => {
        const pos = await TrackPlayer.getPosition();
        const title = currentTitle.current;
        if (title && pos > 0) await libSavePosition(title, pos, duration > 0 ? duration : undefined);
      }, SAVE_INTERVAL_MS);
    } else {
      if (saveTimerRef.current) { clearInterval(saveTimerRef.current); saveTimerRef.current = null; }
      // Save immediately on pause / state change
      if (currentTitle.current && position > 0) {
        libSavePosition(currentTitle.current, position, duration > 0 ? duration : undefined);
      }
    }
    return () => { if (saveTimerRef.current) clearInterval(saveTimerRef.current); };
  }, [playbackState, duration, position]);

  // ── Save on background ────────────────────────────────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (next: AppStateStatus) => {
      if (next !== 'active' && currentTitle.current) {
        const pos = await TrackPlayer.getPosition();
        if (pos > 0) await libSavePosition(currentTitle.current, pos, duration > 0 ? duration : undefined);
      }
      if (next === 'active' && currentTitle.current) {
        // Flush pending timestamps and refresh list
        const logPath = await tsGetLogPath();
        if (logPath) await tsFlush(logPath);
        await refreshTimestamps(currentTitle.current);
      }
    });
    return () => sub.remove();
  }, [duration]);

  // ── Save duration to library once it becomes known ────────────────────────
  useEffect(() => {
    if (duration > 0 && currentTitle.current) {
      libSavePosition(currentTitle.current, position, duration);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  // ── Seek to saved position once track is ready ────────────────────────────
  useTrackPlayerEvents([Event.PlaybackState], async (event) => {
    if (
      (event.state === State.Ready || event.state === State.Paused) &&
      pendingSeekRef.current > 0
    ) {
      await TrackPlayer.seekTo(pendingSeekRef.current);
      pendingSeekRef.current = 0;
    }
  });

  // ── ⏮ fired while app is in foreground ───────────────────────────────────
  // Background case is handled by AudioService; markTimestamp() deduplicates.
  useTrackPlayerEvents([Event.RemotePrevious], async () => {
    if (!currentTitle.current) return;
    const pos = await TrackPlayer.getPosition();
    const entry = await tsMark(currentTitle.current, pos);
    if (entry) showMarked(entry);
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  const refreshTimestamps = useCallback(async (title: string) => {
    const entries = await tsGetEntries(title);
    setTimestamps(entries);
  }, []);

  function showMarked(entry: TimestampEntry) {
    setLastMarked(entry.timestamp);
    setTimestamps(prev => {
      const updated = [...prev.filter(e => e.seconds !== entry.seconds), entry];
      return updated.sort((a, b) => a.seconds - b.seconds);
    });
    setTimeout(() => setLastMarked(null), 2500);
  }

  async function loadTrack(title: string, uri: string, startPosition: number) {
    await TrackPlayer.reset();
    await TrackPlayer.add({ id: '1', url: uri, title, artist: '' });
    currentTitle.current = title;
    setTrackTitle(title);
    await AsyncStorage.setItem('last_track_title', title);
    await AsyncStorage.setItem('last_track_uri', uri);
    if (startPosition > 10) {
      // Seek after the track has loaded (PlaybackState handler above handles this)
      pendingSeekRef.current = startPosition;
    }
    await refreshTimestamps(title);
  }

  async function pickFile() {
    try {
      const [result] = await pick({ type: [types.audio] });
      const name = (result.name ?? 'audio').replace(/\.[^.]+$/, '');
      await loadTrack(name, result.uri, 0);
    } catch (e) {
      if (isErrorWithCode(e) && (e as any).code === errorCodes.OPERATION_CANCELED) return;
      Alert.alert('Could not open file', String(e));
    }
  }

  async function togglePlayPause() {
    const s = await TrackPlayer.getState();
    s === State.Playing ? await TrackPlayer.pause() : await TrackPlayer.play();
  }

  async function skip(delta: number) {
    const pos = await TrackPlayer.getPosition();
    await TrackPlayer.seekTo(Math.max(0, Math.min(pos + delta, duration)));
  }

  async function changeSpeed(s: number) {
    await TrackPlayer.setRate(s);
    setSpeed(s);
  }

  async function handleMark() {
    if (!currentTitle.current) return;
    const pos = await TrackPlayer.getPosition();
    const entry = await tsMark(currentTitle.current, pos);
    if (entry) showMarked(entry);
  }

  const isPlaying  = playbackState === State.Playing;
  const displayPos = isSeeking ? seekValue : position;

  return (
    <View style={s.root}>

      {/* Track title + open file + library link */}
      <View style={s.header}>
        <Text style={s.title} numberOfLines={2}>
          {trackTitle ?? 'No file loaded'}
        </Text>
        <TouchableOpacity onPress={() => navigation.navigate('Settings')} style={s.iconBtn}>
          <Text style={s.iconText}>⚙</Text>
        </TouchableOpacity>
      </View>

      <View style={s.headerActions}>
        <TouchableOpacity style={s.actionBtn} onPress={() => navigation.navigate('Library')}>
          <Text style={s.actionBtnText}>📚  Library</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.actionBtn} onPress={pickFile}>
          <Text style={s.actionBtnText}>📂  Open file</Text>
        </TouchableOpacity>
      </View>

      {/* Progress slider */}
      <View style={s.progressRow}>
        <Text style={s.timeText}>{formatTime(displayPos)}</Text>
        <Slider
          style={s.slider}
          minimumValue={0}
          maximumValue={duration || 1}
          value={displayPos}
          onSlidingStart={() => { setIsSeeking(true); setSeekValue(position); }}
          onValueChange={setSeekValue}
          onSlidingComplete={async v => { setIsSeeking(false); await TrackPlayer.seekTo(v); }}
          minimumTrackTintColor="#a0c4ff"
          maximumTrackTintColor="#2a2a3e"
          thumbTintColor="#a0c4ff"
        />
        <Text style={s.timeText}>{formatTime(duration)}</Text>
      </View>

      {/* Transport */}
      <View style={s.controls}>
        <TouchableOpacity style={s.ctrlBtn} onPress={() => skip(-30)}>
          <Text style={s.ctrlIcon}>⏪</Text>
          <Text style={s.ctrlLabel}>30 s</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.playBtn} onPress={togglePlayPause}>
          <Text style={s.playIcon}>{isPlaying ? '⏸' : '▶'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.ctrlBtn} onPress={() => skip(30)}>
          <Text style={s.ctrlIcon}>⏩</Text>
          <Text style={s.ctrlLabel}>30 s</Text>
        </TouchableOpacity>
      </View>

      {/* Speed */}
      <View style={s.speedRow}>
        {SPEEDS.map(sp => (
          <TouchableOpacity
            key={sp}
            style={[s.speedBtn, speed === sp && s.speedBtnOn]}
            onPress={() => changeSpeed(sp)}
          >
            <Text style={[s.speedText, speed === sp && s.speedTextOn]}>{sp}×</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Mark Timestamp */}
      <TouchableOpacity
        style={[s.markBtn, !trackTitle && s.markBtnOff]}
        onPress={handleMark}
        disabled={!trackTitle}
        activeOpacity={0.7}
      >
        <Text style={s.markText}>
          {lastMarked ? `✓  Marked  ${lastMarked}` : '⏱  Mark Timestamp'}
        </Text>
      </TouchableOpacity>

      {/* Timestamp list */}
      <FlatList
        data={timestamps}
        keyExtractor={(_, i) => String(i)}
        style={s.list}
        ListHeaderComponent={
          timestamps.length > 0
            ? <Text style={s.listHeader}>Timestamps — {timestamps.length}</Text>
            : null
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={s.listRow} onPress={() => TrackPlayer.seekTo(item.seconds)}>
            <Text style={s.listTime}>{item.timestamp}</Text>
            <Text style={s.listState}>{item.processed ? '✓ synced' : '· pending'}</Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          trackTitle
            ? <Text style={s.emptyText}>No timestamps yet.{'\n'}Tap ⏱ or press ⏮ on the lock screen.</Text>
            : null
        }
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, padding: 16 },
  header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  title: { flex: 1, color: '#eee', fontSize: 15, fontWeight: '600', lineHeight: 21 },
  iconBtn: { padding: 6 },
  iconText: { fontSize: 22, color: '#888' },
  headerActions: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  actionBtn: { flex: 1, backgroundColor: '#16213e', borderRadius: 8, padding: 10, alignItems: 'center' },
  actionBtnText: { color: '#a0c4ff', fontSize: 13 },
  progressRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  timeText: { color: '#888', fontSize: 12, width: 46, textAlign: 'center' },
  slider: { flex: 1, height: 36 },
  controls: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 28, marginBottom: 14 },
  ctrlBtn: { alignItems: 'center', gap: 2 },
  ctrlIcon: { fontSize: 30, color: '#eee' },
  ctrlLabel: { fontSize: 11, color: '#888' },
  playBtn: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#a0c4ff', alignItems: 'center', justifyContent: 'center' },
  playIcon: { fontSize: 34, color: '#1a1a2e' },
  speedRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 20 },
  speedBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#444' },
  speedBtnOn: { backgroundColor: '#a0c4ff', borderColor: '#a0c4ff' },
  speedText: { color: '#888', fontSize: 13 },
  speedTextOn: { color: '#1a1a2e', fontWeight: '700' },
  markBtn: { backgroundColor: '#0f3460', borderRadius: 10, paddingVertical: 18, alignItems: 'center', marginBottom: 16, borderWidth: 1, borderColor: '#a0c4ff' },
  markBtnOff: { opacity: 0.4 },
  markText: { color: '#a0c4ff', fontSize: 18, fontWeight: '700' },
  list: { flex: 1 },
  listHeader: { color: '#666', fontSize: 12, marginBottom: 6 },
  listRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a2a3e' },
  listTime: { color: '#eee', fontFamily: 'monospace', fontSize: 14 },
  listState: { color: '#555', fontSize: 11 },
  emptyText: { color: '#555', fontSize: 13, textAlign: 'center', marginTop: 20, lineHeight: 20 },
});
