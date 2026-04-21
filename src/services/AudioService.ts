import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  Event,
  State,
} from 'react-native-track-player';
import { getNextTrack, savePosition } from '../utils/libraryManager';
import { markTimestamp } from '../utils/timestampManager';

export default async function () {
  // updateOptions may fail if setupPlayer hasn't resolved yet; that's fine —
  // the options will be applied when setupPlayer is called from the UI.
  try {
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
        Capability.SkipToPrevious,
        Capability.SkipToNext,
      ],
      compactCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.JumpForward,
      ],
      notificationCapabilities: [
        Capability.SkipToPrevious,
        Capability.JumpBackward,
        Capability.Play,
        Capability.Pause,
        Capability.JumpForward,
        Capability.SkipToNext,
      ],
      forwardJumpInterval: 30,
      backwardJumpInterval: 30,
      color: 0xFFA0C4FF,
    });
  } catch (_) {}

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

  // ⏮ = Mark Timestamp (lock screen / notification / triple-tap headphone)
  TrackPlayer.addEventListener(Event.RemotePrevious, async () => {
    try {
      const [position, queue] = await Promise.all([
        TrackPlayer.getPosition(),
        TrackPlayer.getQueue(),
      ]);
      const title = queue[0]?.title as string | undefined;
      if (title) await markTimestamp(title, position);
    } catch (_) {}
  });

  // ⏭ = Next file in library
  TrackPlayer.addEventListener(Event.RemoteNext, () => advanceToNext());

  // Auto-advance when current track finishes
  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => advanceToNext());

  // Periodic position save (every 60 s while playing)
  setInterval(async () => {
    try {
      const state = await TrackPlayer.getState();
      if (state !== State.Playing) return;
      const [position, queue] = await Promise.all([
        TrackPlayer.getPosition(),
        TrackPlayer.getQueue(),
      ]);
      const title = queue[0]?.title as string | undefined;
      if (title && position > 0) await savePosition(title, position);
    } catch (_) {}
  }, 60_000);
}

async function advanceToNext() {
  try {
    const queue = await TrackPlayer.getQueue();
    const currentTitle = queue[0]?.title as string | undefined;
    if (!currentTitle) return;

    const next = await getNextTrack(currentTitle);
    if (!next) return;

    await TrackPlayer.reset();
    await TrackPlayer.add({ id: '1', url: next.uri, title: next.title, artist: '' });
    await TrackPlayer.play();
  } catch (_) {}
}
