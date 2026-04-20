import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  AppStateStatus,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useIsFocused } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  getFolderPath,
  getLastPlayedTrack,
  getProgress,
  relativeTime,
  scanFolder,
  TrackRecord,
} from '../utils/libraryManager';
import type { RootStackParamList } from '../../App';

export default function LibraryScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const isFocused = useIsFocused();

  const [tracks, setTracks] = useState<TrackRecord[]>([]);
  const [lastPlayed, setLastPlayed] = useState<TrackRecord | null>(null);
  const [folderPath, setFolderPath] = useState('');
  const [scanning, setScanning] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    const folder = await getFolderPath();
    setFolderPath(folder);
    const result = await scanFolder(folder);
    setTracks(result);
    const lp = await getLastPlayedTrack();
    setLastPlayed(lp);
    setScanning(false);
  }, []);

  // Scan on first mount and whenever we return to this screen
  useEffect(() => {
    if (isFocused) scan();
  }, [isFocused, scan]);

  // Also re-scan when app foregrounds (in case files were added while away)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active' && isFocused) scan();
    });
    return () => sub.remove();
  }, [isFocused, scan]);

  function openTrack(track: TrackRecord) {
    navigation.navigate('Player', {
      trackTitle: track.title,
      trackUri: track.uri,
      startPosition: track.positionSeconds,
    });
  }

  function openLastPlayed() {
    if (lastPlayed) openTrack(lastPlayed);
  }

  const renderItem = ({ item }: { item: TrackRecord }) => {
    const pct = getProgress(item);
    const isNew = item.lastPlayedAt === null;

    return (
      <TouchableOpacity style={st.row} onPress={() => openTrack(item)} activeOpacity={0.7}>
        <View style={st.rowTop}>
          <Text style={st.trackName} numberOfLines={2}>{item.title}</Text>
          <Text style={[st.badge, isNew && st.badgeNew]}>
            {isNew ? 'NEW' : pct === 100 ? '✓' : `${pct ?? '?'}%`}
          </Text>
        </View>

        {/* Progress bar */}
        <View style={st.barTrack}>
          <View style={[st.barFill, { width: pct != null ? `${pct}%` : '0%' }]} />
        </View>

        <Text style={st.meta}>
          {item.lastPlayedAt
            ? `Last played ${relativeTime(item.lastPlayedAt)}`
            : `Added ${relativeTime(item.addedAt)}`}
          {item.durationSeconds > 0
            ? `  ·  ${fmtDur(item.durationSeconds)}`
            : ''}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={st.root}>
      {/* Folder path label */}
      <TouchableOpacity
        style={st.folderBar}
        onPress={() => navigation.navigate('Settings')}
      >
        <Text style={st.folderText} numberOfLines={1}>
          📁  {folderPath || 'Tap to set folder in Settings'}
        </Text>
      </TouchableOpacity>

      {/* Continue card */}
      {lastPlayed && (
        <TouchableOpacity style={st.continueCard} onPress={openLastPlayed}>
          <View style={st.continueLeft}>
            <Text style={st.continueLabel}>▶  Continue</Text>
            <Text style={st.continueTitle} numberOfLines={1}>{lastPlayed.title}</Text>
          </View>
          <Text style={st.continueProgress}>
            {getProgress(lastPlayed) != null ? `${getProgress(lastPlayed)}%` : ''}
          </Text>
        </TouchableOpacity>
      )}

      {/* File list */}
      <FlatList
        data={tracks}
        keyExtractor={item => item.title}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl
            refreshing={scanning}
            onRefresh={scan}
            tintColor="#a0c4ff"
            colors={['#a0c4ff']}
          />
        }
        ListEmptyComponent={
          !scanning ? (
            <Text style={st.empty}>
              No audio files found.{'\n'}
              Set the folder in ⚙ Settings, then pull down to refresh.
            </Text>
          ) : null
        }
        contentContainerStyle={tracks.length === 0 && { flex: 1 }}
      />
    </View>
  );
}

function fmtDur(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const ACCENT = '#a0c4ff';
const BG     = '#1a1a2e';
const CARD   = '#0f1a30';

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  folderBar: {
    backgroundColor: CARD,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2a2a3e',
  },
  folderText: { color: '#666', fontSize: 11 },

  continueCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f3460',
    margin: 12,
    marginBottom: 4,
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: ACCENT,
  },
  continueLeft: { flex: 1 },
  continueLabel: { color: ACCENT, fontSize: 11, fontWeight: '700', marginBottom: 2 },
  continueTitle: { color: '#eee', fontSize: 14, fontWeight: '600' },
  continueProgress: { color: ACCENT, fontSize: 22, fontWeight: '700', marginLeft: 12 },

  row: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1e1e30',
  },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  trackName: { flex: 1, color: '#ddd', fontSize: 13, lineHeight: 18, paddingRight: 8 },
  badge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#666',
    minWidth: 36,
    textAlign: 'right',
  },
  badgeNew: { color: ACCENT },

  barTrack: {
    height: 3,
    backgroundColor: '#2a2a3e',
    borderRadius: 2,
    marginBottom: 5,
    overflow: 'hidden',
  },
  barFill: { height: '100%', backgroundColor: ACCENT, borderRadius: 2 },

  meta: { color: '#555', fontSize: 11 },

  empty: {
    color: '#555',
    textAlign: 'center',
    marginTop: 60,
    fontSize: 14,
    lineHeight: 22,
    paddingHorizontal: 32,
  },
});
