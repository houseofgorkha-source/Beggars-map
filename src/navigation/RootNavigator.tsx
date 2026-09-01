import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import MapScreen from '../screens/MapScreen';
import LeaderboardScreen from '../screens/LeaderboardScreen';
import ProfileScreen from '../screens/ProfileScreen';
import AboutScreen from '../screens/AboutScreen';
import ListingDetailScreen from '../screens/ListingDetailScreen';
import AddListingScreen from '../screens/AddListingScreen';
import PickLocationScreen from '../screens/PickLocationScreen';
import SignInScreen from '../screens/SignInScreen';
import LegalScreen from '../screens/LegalScreen';
import type { RootStackParamList, TabParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

// Contribute is no longer a tab — "+ Add" now lives directly on MapScreen
// (matching the current web product) and navigates straight to
// AddListing/SignIn on the root stack, the same way this redirect used to.
// Map and Profile are the only two primary destinations now; Leaderboard and
// About moved to secondary screens on the root stack, reachable from Profile
// (and, for About, from the Map header too).
function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: true,
        tabBarActiveTintColor: '#ec4899',
        tabBarInactiveTintColor: '#999',
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        tabBarStyle: {
          backgroundColor: '#fff',
          borderTopWidth: 1,
          borderTopColor: '#eee',
          height: 58,
          paddingTop: 6,
          shadowColor: '#000',
          shadowOpacity: 0.06,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: -2 },
          elevation: 8,
        },
      }}
    >
      <Tab.Screen
        name="Map"
        component={MapScreen}
        options={{
          headerShown: false,
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'map' : 'map-outline'} color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'person' : 'person-outline'} color={color} size={size} />
          ),
        }}
      />
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
        <Stack.Screen name="Leaderboard" component={LeaderboardScreen} options={{ title: 'Leaderboard' }} />
        <Stack.Screen name="About" component={AboutScreen} options={{ title: 'About Us' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
