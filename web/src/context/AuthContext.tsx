import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { detectLanguage } from '../i18n/language';
import type { Language } from '../i18n/language';

export type { Language };

export interface Profile {
  display_name: string | null;
  language: Language | null;
}

type AuthResult = { error: { message: string; code?: string } | null };

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  isAnonymous: boolean;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signUp: (
    email: string,
    password: string,
    displayName: string
  ) => Promise<AuthResult & { needsEmailConfirmation: boolean }>;
  signInAnonymously: () => Promise<AuthResult>;
  resetPassword: (email: string) => Promise<AuthResult>;
  updatePassword: (password: string) => Promise<AuthResult>;
  updateProfile: (patch: Partial<Profile>) => Promise<AuthResult>;
  deleteAccount: () => Promise<AuthResult>;
  signOut: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const userId = user?.id ?? null;

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Keep this callback synchronous since no supabase calls inside it
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Load the profile (created by the database trigger) whenever the user changes
  useEffect(() => {
    if (!userId) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    supabase
      .from('profiles')
      .select('display_name, language')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) console.error('Profile load failed:', error.message);
        if (!cancelled) setProfile((data as Profile | null) ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const signIn = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, displayName: string) => {
      // Guest to real account: keep the same user id so their fields are kept
      if (user?.is_anonymous) {
        const { data, error } = await supabase.auth.updateUser({
          email,
          password,
          data: { display_name: displayName },
        });
        if (error) return { error, needsEmailConfirmation: false };
        await supabase.from('profiles').update({ display_name: displayName }).eq('id', user.id);
        setProfile((prev) => ({ display_name: displayName, language: prev?.language ?? null }));
        return { error: null, needsEmailConfirmation: Boolean(data.user?.new_email) };
      }

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { display_name: displayName, language: detectLanguage() },
          emailRedirectTo: `${window.location.origin}/dashboard`,
        },
      });
      if (error) return { error, needsEmailConfirmation: false };

      // With email confirmation on, an already-registered address returns a user with no identities
      if (data.user && data.user.identities?.length === 0) {
        return {
          error: {
            message: 'An account with this email already exists. Sign in instead.',
            code: 'user_already_exists',
          },
          needsEmailConfirmation: false,
        };
      }
      return { error: null, needsEmailConfirmation: !data.session };
    },
    [user]
  );

  const signInAnonymously = useCallback(async (): Promise<AuthResult> => {
    const { error } = await supabase.auth.signInAnonymously({
      options: { data: { language: detectLanguage() } },
    });
    if (error) console.error('Guest auth failed:', error.message);
    return { error };
  }, []);

  const resetPassword = useCallback(async (email: string): Promise<AuthResult> => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    return { error };
  }, []);

  const updatePassword = useCallback(async (password: string): Promise<AuthResult> => {
    const { error } = await supabase.auth.updateUser({ password });
    return { error };
  }, []);

  const updateProfile = useCallback(
    async (patch: Partial<Profile>): Promise<AuthResult> => {
      if (!userId) return { error: { message: 'You are not signed in.', code: 'not_signed_in' } };
      const { error } = await supabase.from('profiles').update(patch).eq('id', userId);
      if (!error) {
        setProfile((prev) => ({
          display_name: prev?.display_name ?? null,
          language: prev?.language ?? null,
          ...patch,
        }));
      }
      return { error };
    },
    [userId]
  );

  const deleteAccount = useCallback(async (): Promise<AuthResult> => {
    const { error } = await supabase.rpc('delete_my_account');
    if (error) return { error };
    // The user row is gone, so only clear the local session
    await supabase.auth.signOut({ scope: 'local' });
    return { error: null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const getAccessToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, []);

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      session,
      profile,
      loading,
      isAnonymous: Boolean(user?.is_anonymous),
      signIn,
      signUp,
      signInAnonymously,
      resetPassword,
      updatePassword,
      updateProfile,
      deleteAccount,
      signOut,
      getAccessToken,
    }),
    [
      user,
      session,
      profile,
      loading,
      signIn,
      signUp,
      signInAnonymously,
      resetPassword,
      updatePassword,
      updateProfile,
      deleteAccount,
      signOut,
      getAccessToken,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};