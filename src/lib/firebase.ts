import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, type Auth } from "firebase/auth";
import { getFirestore as getClientFirestore, type Firestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
};

let _app: FirebaseApp | null = null;
let _auth: Auth | null = null;
let _db: Firestore | null = null;

function getFirebaseApp(): FirebaseApp {
  if (_app) return _app;
  _app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
  return _app;
}

function getFirebaseAuth(): Auth {
  if (_auth) return _auth;
  _auth = getAuth(getFirebaseApp());
  return _auth;
}

// Firestore is used purely as a push channel: the OCR/Translate workers mirror
// job status into `{feature}_jobs/{jobId}`, and the client subscribes via
// onSnapshot instead of polling. Reads are authenticated by the signed-in
// Firebase user and gated by Firestore rules (see firestore.rules).
function getFirebaseFirestore(): Firestore {
  if (_db) return _db;
  _db = getClientFirestore(getFirebaseApp());
  return _db;
}

const googleProvider = new GoogleAuthProvider();

export { getFirebaseAuth as getAuth, getFirebaseFirestore as getFirestore, googleProvider };
