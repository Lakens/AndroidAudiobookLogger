import React, { useEffect, useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { check, PERMISSIONS, request, RESULTS } from 'react-native-permissions';
import {
  DEFAULT_FOLDER,
  getFolderPath,
  setFolderPath,
} from '../utils/libraryManager';
import {
  flushPendingToLog,
  getLogPath,
  getPendingCount,
} from '../utils/timestampManager';

const DEFAULT_LOG_PATH = Platform.OS === 'android'
  ? `${RNFS.ExternalStorageDirectoryPath}/OneDrive - TU Eindhoven/obsidian/99 - System/timestamp_log.json`
  : '';

export default function SettingsScreen() {
  const [folderPath, setFolderPathState] = useState('');
  const [logPath, setLogPath] = useState('');
  const [status, setStatus] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const [storageGranted, setStorageGranted] = useState<boolean | null>(null);

  useEffect(() => {
    async function load() {
      setFolderPathState(await getFolderPath());
      setLogPath((await getLogPath()) ?? DEFAULT_LOG_PATH);
      setPendingCount(await getPendingCount());
      await checkPermission();
    }
    load();
  }, []);

  // Refresh pending count whenever the screen comes into focus
  useEffect(() => {
    const interval = setInterval(async () => {
      setPendingCount(await getPendingCount());
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  async function checkPermission() {
    if (Platform.OS !== 'android') { setStorageGranted(true); return; }
    const ver = Number(Platform.Version);
    if (ver >= 33) {
      const result = await check(PERMISSIONS.ANDROID.READ_MEDIA_AUDIO);
      setStorageGranted(result === RESULTS.GRANTED);
    } else if (ver >= 30) {
      try {
        const testPath = `${RNFS.ExternalStorageDirectoryPath}/.rn_perm_test`;
        await RNFS.writeFile(testPath, '', 'utf8');
        await RNFS.unlink(testPath);
        setStorageGranted(true);
      } catch {
        setStorageGranted(false);
      }
    } else {
      const result = await check(PERMISSIONS.ANDROID.WRITE_EXTERNAL_STORAGE);
      setStorageGranted(result === RESULTS.GRANTED);
    }
  }

  async function requestPermission() {
    const ver = Number(Platform.Version);
    if (ver >= 33) {
      const result = await request(PERMISSIONS.ANDROID.READ_MEDIA_AUDIO);
      setStorageGranted(result === RESULTS.GRANTED);
    } else if (ver >= 30) {
      Alert.alert(
        'Storage Permission',
        'Android 11+ requires "All files access" to browse your audio folder.\n\n'
        + 'Tap "Open Settings", then enable "Allow management of all files".',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Open Settings',
            onPress: () =>
              Linking.sendIntent('android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION', [
                { key: 'package', value: 'com.audiobooknotetaker' },
              ]).catch(() => Linking.openSettings()),
          },
        ],
      );
    } else {
      const result = await request(PERMISSIONS.ANDROID.WRITE_EXTERNAL_STORAGE);
      setStorageGranted(result === RESULTS.GRANTED);
    }
  }

  async function saveFolderPath() {
    const path = folderPath.trim();
    if (!path) { Alert.alert('Error', 'Path cannot be empty.'); return; }
    await setFolderPath(path);
    flash('Audio folder saved. Pull to refresh in Library.');
  }

  async function testFolderPath() {
    const path = folderPath.trim();
    if (!path) return;
    const exists = await RNFS.exists(path);
    let count = 0;
    if (exists) {
      const items = await RNFS.readDir(path).catch(() => []);
      count = items.filter(i => /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i.test(i.name)).length;
    }
    Alert.alert(
      'Folder check',
      `Exists: ${exists ? '✓' : '✗'}\nAudio files found: ${count}\n\n${path}`,
    );
  }

  async function saveLogPath() {
    const path = logPath.trim();
    if (!path) { Alert.alert('Error', 'Path cannot be empty.'); return; }
    await AsyncStorage.setItem('timestamp_log_path', path);
    if (pendingCount > 0) {
      try {
        const n = await flushPendingToLog(path);
        setPendingCount(0);
        flash(`Log path saved — flushed ${n} pending timestamp(s).`);
      } catch (e: any) {
        flash('Saved, but flush failed: ' + e.message);
      }
    } else {
      flash('Log path saved.');
    }
  }

  async function testLogPath() {
    const path = logPath.trim();
    if (!path) return;
    const dir = path.substring(0, path.lastIndexOf('/'));
    const dirExists = await RNFS.exists(dir);
    const fileExists = await RNFS.exists(path);
    let entryCount = '—';
    if (fileExists) {
      try {
        const contents = await RNFS.readFile(path, 'utf8');
        const entries = JSON.parse(contents);
        entryCount = Array.isArray(entries) ? String(entries.length) : 'invalid JSON';
      } catch {
        entryCount = 'could not read';
      }
    }
    Alert.alert(
      'Log path check',
      `Directory exists: ${dirExists ? '✓' : '✗'}\n`
      + `File exists: ${fileExists ? '✓' : '✗'}\n`
      + `Entries in file: ${entryCount}\n`
      + `Pending (not yet flushed): ${pendingCount}\n\n`
      + path,
    );
  }

  async function flushPending() {
    const path = logPath.trim();
    if (!path) { Alert.alert('Error', 'Save the log path first.'); return; }
    try {
      const n = await flushPendingToLog(path);
      setPendingCount(0);
      if (n === 0) {
        Alert.alert(
          'Nothing to flush',
          'There are no pending timestamps.\n\n'
          + 'Timestamps marked while a log path was already set are written directly to that file — '
          + 'use the Test button to see how many entries are currently in the file.',
        );
      } else {
        flash(`Flushed ${n} pending timestamp(s) to log.`);
      }
    } catch (e: any) {
      Alert.alert('Flush failed', e.message);
    }
  }

  function flash(msg: string) {
    setStatus(msg);
    setTimeout(() => setStatus(''), 3000);
  }

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>

      {storageGranted === false && (
        <TouchableOpacity style={s.permBanner} onPress={requestPermission}>
          <Text style={s.permBannerText}>
            ⚠  Storage permission needed — tap to grant
          </Text>
        </TouchableOpacity>
      )}

      {/* ── Audio folder ─────────────────────────────────────────────────── */}
      <Text style={s.label}>Audio folder</Text>
      <Text style={s.hint}>
        The folder to index for audiobooks. Defaults to the Obsidian pdf_audio_outputs folder.
      </Text>
      <TextInput
        style={s.input}
        value={folderPath}
        onChangeText={setFolderPathState}
        placeholder={DEFAULT_FOLDER}
        placeholderTextColor="#555"
        multiline
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={s.row}>
        <TouchableOpacity style={s.btn} onPress={saveFolderPath}>
          <Text style={s.btnText}>Save folder</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btn, s.btnOutline]} onPress={testFolderPath}>
          <Text style={[s.btnText, s.btnTextOutline]}>Test</Text>
        </TouchableOpacity>
      </View>

      <View style={s.divider} />

      {/* ── Timestamp log path ───────────────────────────────────────────── */}
      <Text style={s.label}>Timestamp log path</Text>
      <Text style={s.hint}>
        Full path to <Text style={s.code}>timestamp_log.json</Text> in your Obsidian vault.
      </Text>
      <TextInput
        style={s.input}
        value={logPath}
        onChangeText={setLogPath}
        placeholder={DEFAULT_LOG_PATH}
        placeholderTextColor="#555"
        multiline
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={s.row}>
        <TouchableOpacity style={s.btn} onPress={saveLogPath}>
          <Text style={s.btnText}>Save path</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btn, s.btnOutline]} onPress={testLogPath}>
          <Text style={[s.btnText, s.btnTextOutline]}>Test</Text>
        </TouchableOpacity>
      </View>

      {pendingCount > 0 && (
        <TouchableOpacity style={s.flushBtn} onPress={flushPending}>
          <Text style={s.btnText}>⬆  Flush {pendingCount} pending timestamp(s)</Text>
        </TouchableOpacity>
      )}

      {!!status && <Text style={s.status}>{status}</Text>}

      <View style={s.divider} />

      {/* ── How to mark ──────────────────────────────────────────────────── */}
      <Text style={s.sectionTitle}>How to mark timestamps</Text>
      <Text style={s.body}>
        {'1.  '}<Text style={s.em}>Tap ⏱ Mark Timestamp</Text>{' in the player.\n\n'}
        {'2.  '}<Text style={s.em}>Tap ⏮ (Previous) on the lock screen or notification.</Text>
        {'\n\n'}
        {'3.  '}<Text style={s.em}>Triple-press the centre headphone button</Text>
        {' — Android maps triple-tap to "previous track" on most headphones, '
        + 'which this app intercepts to mark a timestamp instead.\n\n'}
        {'All methods write directly to '}
        <Text style={s.code}>timestamp_log.json</Text>
        {', ready for '}
        <Text style={s.code}>process_timestamps.py</Text>{'.\n\n'}
        {'The note path is derived from the audio filename (extension stripped), '
        + 'so the MP3 name must match the Obsidian note stem exactly.'}
      </Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 20, paddingBottom: 40 },
  permBanner: { backgroundColor: '#7b2d2d', borderRadius: 8, padding: 12, marginBottom: 16 },
  permBannerText: { color: '#ffa', fontSize: 13, lineHeight: 18 },
  label: { color: '#eee', fontSize: 14, fontWeight: '600', marginBottom: 4 },
  hint: { color: '#777', fontSize: 12, lineHeight: 17, marginBottom: 10 },
  code: { fontFamily: 'monospace', color: '#a0c4ff', fontSize: 12 },
  input: {
    backgroundColor: '#0f1a30',
    borderRadius: 8,
    color: '#ccc',
    fontSize: 12,
    fontFamily: 'monospace',
    padding: 12,
    minHeight: 70,
    textAlignVertical: 'top',
    marginBottom: 12,
  },
  row: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  btn: { flex: 1, backgroundColor: '#a0c4ff', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  btnOutline: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#a0c4ff' },
  btnText: { color: '#1a1a2e', fontWeight: '700', fontSize: 13 },
  btnTextOutline: { color: '#a0c4ff' },
  flushBtn: { backgroundColor: '#3a6ea5', borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginBottom: 10 },
  status: { color: '#a0c4ff', textAlign: 'center', fontSize: 13, marginTop: 6 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#2a2a3e', marginVertical: 24 },
  sectionTitle: { color: '#eee', fontSize: 14, fontWeight: '600', marginBottom: 10 },
  body: { color: '#999', fontSize: 13, lineHeight: 21 },
  em: { color: '#eee', fontWeight: '600' },
});
