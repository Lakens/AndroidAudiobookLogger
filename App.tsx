import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import LibraryScreen from './src/screens/LibraryScreen';
import PlayerScreen from './src/screens/PlayerScreen';
import SettingsScreen from './src/screens/SettingsScreen';

export type RootStackParamList = {
  Library: undefined;
  Player: {
    trackTitle: string;
    trackUri: string;
    startPosition: number;
  } | undefined;
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName="Library"
        screenOptions={{
          headerStyle: { backgroundColor: '#0f3460' },
          headerTintColor: '#a0c4ff',
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: '#1a1a2e' },
        }}
      >
        <Stack.Screen
          name="Library"
          component={LibraryScreen}
          options={{ title: 'Audiobook Library' }}
        />
        <Stack.Screen
          name="Player"
          component={PlayerScreen}
          options={{ title: 'Now Playing' }}
        />
        <Stack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ title: 'Settings' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
