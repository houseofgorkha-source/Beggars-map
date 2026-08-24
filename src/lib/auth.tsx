import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Profile } from '../types/database';

WebBrowser.maybeCompleteAuthSession();

type AuthContextValue = {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user) {
      setProfile(null);
      return;
    }

    let cancelled = false;

    async function ensureProfile() {
      const userId = session!.user.id;
      const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();

      if (cancelled) return;

      if (data) {
        setProfile(data as Profile);
        return;
      }

      const defaultName =
        session!.user.user_metadata?.full_name ?? session!.user.email ?? 'New contributor';
      const { data: created } = await supabase
        .from('profiles')
        .insert({ id: userId, display_name: defaultName })
        .select('*')
        .single();

      if (!cancelled && created) setProfile(created as Profile);
    }

    ensureProfile();

    return () => {
      cancelled = true;
    };
  }, [session?.user.id]);

  async function signInWithGoogle() {
    const redirectTo = AuthSession.makeRedirectUri({ scheme: 'beggarsmap' });

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error || !data.url) return { error: error?.message ?? 'Could not start sign-in' };

    const redirectUrl = await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (url: string | null) => {
        if (settled) return;
        settled = true;
        subscription.remove();
        resolve(url);
      };

      const subscription = Linking.addEventListener('url', (event) => finish(event.url));

      WebBrowser.openAuthSessionAsync(data.url, redirectTo).then((result) => {
        if (result.type === 'success' && result.url) {
          finish(result.url);
        } else if (result.type === 'dismiss') {
          // Android sometimes closes the browser via a native deep-link handoff
          // instead of resolving with the redirect URL — give the Linking event
          // a moment to arrive before treating this as a cancel.
          setTimeout(() => finish(null), 1500);
        } else {
          finish(null);
        }
      });
    });

    if (!redirectUrl) return { error: null };

    const code = new URL(redirectUrl).searchParams.get('code');
    if (!code) return { error: 'Sign-in response was missing a code' };

    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    return { error: exchangeError?.message ?? null };
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <AuthContext.Provider value={{ session, profile, loading, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
