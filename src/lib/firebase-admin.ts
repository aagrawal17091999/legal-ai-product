import {
  initializeApp,
  getApps,
  cert,
  type ServiceAccount,
  type App,
} from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import { logError } from "./error-logger";

let _app: App | null = null;
let _adminAuth: Auth | null = null;
let _db: Firestore | null = null;

function getAdminApp(): App {
  if (_app) return _app;
  if (getApps().length > 0) {
    _app = getApps()[0];
    return _app;
  }
  const serviceAccountKey = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_KEY;
  if (!serviceAccountKey) {
    throw new Error(
      "FIREBASE_ADMIN_SERVICE_ACCOUNT_KEY is not set. Add it to .env.local (see .env.local.example)"
    );
  }
  const serviceAccount: ServiceAccount = JSON.parse(serviceAccountKey);
  _app = initializeApp({ credential: cert(serviceAccount) });
  return _app;
}

function getAdminAuth(): Auth {
  if (_adminAuth) return _adminAuth;
  _adminAuth = getAuth(getAdminApp());
  return _adminAuth;
}

function getAdminFirestore(): Firestore {
  if (_db) return _db;
  _db = getFirestore(getAdminApp());
  return _db;
}

/** Firestore collection that mirrors a feature's job status for client push. */
function jobCollection(feature: "ocr" | "translate"): string {
  return feature === "ocr" ? "ocr_jobs" : "translate_jobs";
}

/**
 * Mirror a job's status into Firestore so the client gets an instant `onSnapshot`
 * push instead of polling. Postgres remains the source of truth — this document
 * carries only what the UI needs to know a job changed (status + ownerUid for the
 * security rule). Best-effort: a Firestore failure must never fail the job, so
 * errors are logged and swallowed.
 *
 * Called at upload (create the doc with ownerUid) and from the worker on the
 * terminal transition (status → 'ready' | 'failed').
 */
export async function mirrorJobStatus(
  feature: "ocr" | "translate",
  jobId: string,
  fields: { ownerUid?: string; status: string; error?: string | null }
): Promise<void> {
  try {
    await getAdminFirestore()
      .collection(jobCollection(feature))
      .doc(jobId)
      .set({ ...fields, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  } catch (err) {
    logError({
      category: "database",
      message: `Firestore mirror failed for ${feature} job ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "warning",
      metadata: { feature, jobId },
    });
  }
}

export { getAdminAuth as adminAuth };
