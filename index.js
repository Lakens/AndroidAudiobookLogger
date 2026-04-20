import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import TrackPlayer from 'react-native-track-player';

AppRegistry.registerComponent(appName, () => App);

// Register the background playback service — must be called before any player use
TrackPlayer.registerPlaybackService(() => require('./src/services/AudioService'));
