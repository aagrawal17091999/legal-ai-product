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
  let serviceAccount: ServiceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountKey);
  } catch (err) {
    // Say WHICH variable is broken and what it looks like. A bare
    // `SyntaxError: Expected property name...` from JSON.parse is caught by
    // verifyAuth and surfaces as a plain 401, so a config fault reads as "the
    // user isn't signed in" — which is how a total auth outage on 2026-08-21
    // was first reported as "account settings won't load".
    //
    // The cause that time is worth naming: the env file was CORRECT, but
    // `@next/env` only fills in variables missing from process.env, so a
    // shell-mangled FIREBASE_ADMIN_SERVICE_ACCOUNT_KEY exported elsewhere in
    // the environment shadowed it. Hence the fingerprint below rather than
    // "check the .env file" — compare it against the file to spot a shadow.
    // Length and first/last character only; never the key itself.
    const shape = `${serviceAccountKey.length} chars, starts ${JSON.stringify(
      serviceAccountKey.slice(0, 1)
    )}, ends ${JSON.stringify(serviceAccountKey.slice(-1))}`;
    throw new Error(
      `FIREBASE_ADMIN_SERVICE_ACCOUNT_KEY is not valid JSON (${shape}): ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `The value the process resolved may differ from the one in your env file — ` +
        `an exported variable of the same name shadows it. ` +
        `Verify with: node -e 'require("@next/env").loadEnvConfig(process.cwd(), false); ` +
        `JSON.parse(process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_KEY)'`
    );
  }
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
