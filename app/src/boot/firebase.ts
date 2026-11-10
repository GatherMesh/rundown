import { defineBoot } from '#q-app/wrappers';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  signInAnonymously,
  isSignInWithEmailLink,
  signInWithEmailLink,
} from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  connectFirestoreEmulator,
  type Firestore,
} from 'firebase/firestore';
import { getStorage, connectStorageEmulator } from 'firebase/storage';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import { createPinia } from 'pinia';
import { useWorkspace } from '../stores/workspace';
const env = import.meta.env;
export const emulator = env.VITE_USE_EMULATORS === 'true';
export const configured = !!env.VITE_FIREBASE_PROJECT_ID;
const firebase = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY || 'demo-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'demo-rundown.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'demo-rundown',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || 'demo-rundown.appspot.com',
  appId: env.VITE_FIREBASE_APP_ID || 'demo-app',
});
export const auth = getAuth(firebase);
export const db: Firestore =
  import.meta.hot?.data.db ??
  initializeFirestore(firebase, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
export const storage = getStorage(firebase);
export const functions = getFunctions(firebase, 'australia-southeast1');
if (emulator && !import.meta.hot?.data.connected) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}
if (import.meta.hot) {
  import.meta.hot.data.db = db;
  import.meta.hot.data.connected = true;
}
export default defineBoot(async ({ app }) => {
  const pinia = createPinia();
  app.use(pinia);
  const store = useWorkspace(pinia);
  onAuthStateChanged(auth, (user) => void store.setUser(user));
  try {
    if (isSignInWithEmailLink(auth, location.href)) {
      const email =
        localStorage.getItem('rundown-email') ||
        window.prompt('Confirm your email address to finish signing in.');
      if (email) {
        await signInWithEmailLink(auth, email, location.href);
        localStorage.removeItem('rundown-email');
        history.replaceState({}, '', location.pathname);
      }
    }
    if (emulator) {
      await auth.authStateReady();
      if (!auth.currentUser) await signInAnonymously(auth);
    }
  } catch (e) {
    store.fail(e);
  }
});
