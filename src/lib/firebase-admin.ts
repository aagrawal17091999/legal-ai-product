import {
  initializeApp,
  getApps,
  cert,
  type ServiceAccount,
  type App,
} from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";

let _adminAuth: Auth | null = null;

function getAdminAuth(): Auth {
  if (_adminAuth) return _adminAuth;

  let app: App;
  if (getApps().length > 0) {
    app = getApps()[0];
  } else {
    const serviceAccountKey = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_KEY;
    if (!serviceAccountKey) {
      throw new Error(
        "FIREBASE_ADMIN_SERVICE_ACCOUNT_KEY is not set. Add it to .env.local (see .env.local.example)"
      );
    }
    const serviceAccount: ServiceAccount = JSON.parse(serviceAccountKey);
    app = initializeApp({ credential: cert(serviceAccount) });
  }

  _adminAuth = getAuth(app);
  return _adminAuth;
}

export { getAdminAuth as adminAuth };
