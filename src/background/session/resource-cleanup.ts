import { deleteSessionDocuments } from "../../shared/documents/document-store.js";
import { clearSessionResourceArtifacts } from "../../shared/session/session-resource-ledger.js";

/** Global Data tables, gallery assets and downloaded files are independent user resources. */
export async function removeOwnedSessionResources(sessionId: string) {
  await deleteSessionDocuments(sessionId);
  await clearSessionResourceArtifacts(sessionId);
}
