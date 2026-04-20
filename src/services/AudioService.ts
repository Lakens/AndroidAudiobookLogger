/**
 * AudioService — Android foreground service for background audio.
 *
 * Responsibilities:
 *  - Handle all remote media events (headphones, lock screen, notification).
 *  - ⏮ Previous / triple-tap headphone → mark timestamp.
 *  - ⏭ Next → advance to the next file in the sorted library.
 *  - Save playback position to the library every 60 s while playing.
 */
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  Event,
  State,
} from 'react-native-track-player';
import { getNextTrack, savePosition } from '../utils/libraryManager';
import { markTimestamp } from '../utils/timestampManager';

export default async function () {
  await TrackPlayer.updateOptions({
    android: {
      appKilledPlaybackBehavior:
        AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
    },
    capabilities: [
      Capability.Play,
      Capability.Pause,
      Capability.SeekTo,
      Capability.JumpForward,
      Capability.JumpBackward,
      Capability.SkipToPrevious, // ⏮ = Mark Timestamp
      Capability.SkipToNext,     // ⏭ = Next file in library
    ],
    compactCapabilities: [
      Capability.Play,
      Capability.Pause,
      Capability.JumpForward,
    ],
    notificationCapabilities: [
      Capability.SkipToPrevious, // ⏮ Mark
      Capability.JumpBackward,   // ⏪ 30 s
      Capability.Play,
      Capability.Pause,
      Capability.JumpForward,    // ⏩ 30 s
      Capability.SkipToNext,     // ⏭ Next
    ],
    forwardJumpInterval: 30,
    backwardJumpInterval: 30,
  });

  // ── Standard transport ───────────────────────────────────────────────────
  TrackPlayer.addEventListener(Event.RemotePlay,  () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop,  () => TrackPlayer.stop());
  TrackPlayer.addEventListener(Event.RemoteSeek, ({ position }) =>
    TrackPlayer.seekTo(position),
  );
  TrackPlayer.addEventListener(Event.RemoteJumpForward, async ({ interval }) => {
    const pos = await TrackPlayer.getPosition();
    await TrackPlayer.seekTo(pos + interval);
  });
  TrackPlayer.addEventListener(Event.RemoteJumpBackward, async ({ interval }) => {
    const pos = await TrackPlayer.getPosition();
    await TrackPlayer.seekTo(Math.max(0, pos - interval));
  });

  // ── ⏮ = Mark Timestamp (lock screen / notification / triple-tap headphone) ─
  TrackPlayer.addEventListener(Event.RemotePrevious, async () => {
    const [position, queue] = await Promise.all([
      TrackPlayer.getPosition(),
      TrackPlayer.getQueue(),
    ]);
    const title = queue[0]?.title as string | undefined;
    if (title) await markTimestamp(title, position);
  });

  // ── ⏭ = Next file in library ─────────────────────────────────────────────
  TrackPlayer.addEventListener(Event.RemoteNext, () => advanceToNext());

  // Auto-advance when current track finishes
  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => advanceToNext());

  // ── Periodic position save (every 60 s while playing) ────────────────────
  setInterval(async () => {
    const state = await TrackPlayer.getState();
    if (state !== State.Playing) return;
    const [position, queue] = await Promise.all([
      TrackPlayer.getPosition(),
      TrackPlayer.getQueue(),
    ]);
    const title = queue[0]?.title as string | undefined;
    if (title && position > 0) await savePosition(title, position);
  }, 60_000);
};

async function advanceToNext() {
  const queue = await TrackPlayer.getQueue();
  const currentTitle = queue[0]?.title as string | undefined;
  if (!currentTitle) return;

  const next = await getNextTrack(currentTitle);
  if (!next) return;

  await TrackPlayer.reset();
  await TrackPlayer.add({ id: '1', url: next.uri, title: next.title, artist: '' });
  await TrackPlayer.play();
}
