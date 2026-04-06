"use client";

import { useState, useEffect, useCallback } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
  type User as FirebaseUser,
} from "firebase/auth";
import { getAuth, googleProvider } from "@/lib/firebase";

interface AuthState {
  user: FirebaseUser | null;
  loading: boolean;
  token: string | null;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    token: null,
  });

  useEffect(() => {
    const auth = getAuth();
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        const token = await user.getIdToken();
        setState({ user, loading: false, token });
      } else {
        setState({ user: null, loading: false, token: null });
      }
    });
    return unsubscribe;
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const auth = getAuth();
    const result = await signInWithEmailAndPassword(auth, email, password);
    const token = await result.user.getIdToken();
    setState({ user: result.user, loading: false, token });
    return result.user;
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, displayName: string) => {
      const auth = getAuth();
      const result = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(result.user, { displayName });
      const token = await result.user.getIdToken();
      setState({ user: result.user, loading: false, token });
      return result.user;
    },
    []
  );

  const signInWithGoogle = useCallback(async () => {
    const auth = getAuth();
    const result = await signInWithPopup(auth, googleProvider);
    const token = await result.user.getIdToken();
    setState({ user: result.user, loading: false, token });
    return result.user;
  }, []);

  const signOut = useCallback(async () => {
    const auth = getAuth();
    await firebaseSignOut(auth);
    setState({ user: null, loading: false, token: null });
  }, []);

  const getToken = useCallback(async () => {
    if (state.user) {
      return await state.user.getIdToken();
    }
    return null;
  }, [state.user]);

  return {
    user: state.user,
    loading: state.loading,
    token: state.token,
    signIn,
    signUp,
    signInWithGoogle,
    signOut,
    getToken,
  };
}
