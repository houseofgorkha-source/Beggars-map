import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer, useNavigation } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import MapScreen from '../screens/MapScreen';
import LeaderboardScreen from '../screens/LeaderboardScreen';
import ProfileScreen from '../screens/ProfileScreen';
import ListingDetailScreen from '../screens/ListingDetailScreen';
import AddListingScreen from '../screens/AddListingScreen';
import PickLocationScreen from '../screens/PickLocationScreen';
import SignInScreen from '../screens/SignInScreen';
import LegalScreen from '../screens/LegalScreen';
import { useAuth } from '../lib/auth';
import type { RootStackParamList, TabParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

// Normally not rendered at all — the Contribute tab's press is intercepted
// and redirected to the AddListing/SignIn screen on the root stack instead.
// It only actually renders (briefly) when the initial session fetch is still
// in flight, so it can wait for `loading` to resolve before deciding where
// to send the user instead of guessing "no session yet" as "signed out".
function ContributeRedirect() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { session, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    navigation.getParent<NativeStackNavigationProp<RootStackParamList>>()?.navigate(session ? 'AddListing' : 'SignIn');
  }, [navigation, session, loading]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator />
    </View>
  );
}

function Tabs() {
  const { session, loading } = useAuth();

  return (
    <Tab.Navigator screenOptions={{ headerShown: true }}>
      <Tab.Screen name="Map" component={MapScreen} options={{ headerShown: false }} />
      <Tab.Screen
        name="Contribute"
        component={ContributeRedirect}
        listeners={({ navigation }) => ({
          tabPress: (e) => {
            if (loading) {
              // Session status isn't known yet — let the tab switch happen
              // normally so ContributeRedirect can wait it out and redirect
              // once it resolves, instead of guessing "signed out" here.
              return;
            }
            e.preventDefault();
            navigation.getParent<NativeStackNavigationProp<RootStackParamList>>()?.navigate(
              session ? 'AddListing' : 'SignIn'
            );
          },
        })}
      />
      <Tab.Screen name="Leaderboard" component={LeaderboardScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

export default function RootNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
        <Stack.Screen name="ListingDetail" component={ListingDetailScreen} options={{ title: 'Details' }} />
        <Stack.Screen
          name="AddListing"
          component={AddListingScreen}
          options={{ title: 'Add a listing', presentation: 'modal' }}
        />
        <Stack.Screen
          name="PickLocation"
          component={PickLocationScreen}
          options={{ title: 'Pick a location', presentation: 'modal' }}
        />
        <Stack.Screen
          name="SignIn"
          component={SignInScreen}
          options={{ title: 'Sign in', presentation: 'modal' }}
        />
        <Stack.Screen
          name="Legal"
          component={LegalScreen}
          options={{ title: 'Legal', presentation: 'modal' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
