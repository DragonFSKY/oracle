export type RelayTaskStatus =
  | "uploading"
  | "queued"
  | "claimed"
  | "awaiting-response"
  | "completed"
  | "cancelled"
  | "expired";

export interface RelayAttachmentDescriptor {
  id: string;
  filename: string;
  displayPath: string;
  mimeType?: string;
  sizeBytes: number;
  sha256: string;
  direction: "request" | "response";
}

export interface RelayResponseSubmission {
  markdown: string;
  attachments?: Array<{
    filename: string;
    mimeType?: string;
    contentBase64: string;
  }>;
}

export interface RelayResponseUploadRequest {
  operator: string;
  markdown: string;
  attachments: Array<{
    filename: string;
    mimeType?: string;
    sizeBytes: number;
    sha256: string;
  }>;
}

export interface RelayResponseUploadPlan {
  id: string;
  attachments: RelayAttachmentDescriptor[];
  uploadChunkBytes: number;
  /** Local receivers may already have durably accepted this exact response. */
  alreadyComplete?: boolean;
}

export interface RelayLocalReceiver {
  version: 1;
  /** Must be an HTTP loopback URL; operators reject every non-loopback value. */
  baseUrl: string;
  /** Random, task-scoped bearer capability. */
  token: string;
  expiresAt: string;
}

export interface RelayTask {
  id: string;
  /** Stable producer-supplied idempotency key. */
  requestId?: string;
  /** Server-computed fingerprint used to reject conflicting request-id reuse. */
  requestFingerprint?: string;
  /** Monotonic persisted snapshot revision. */
  revision?: number;
  status: RelayTaskStatus;
  title: string;
  prompt: string;
  modelHint?: string;
  source?: string;
  sessionId?: string;
  localReceiver?: RelayLocalReceiver;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  claimedAt?: string;
  claimExpiresAt?: string;
  claimedBy?: string;
  submittedAt?: string;
  completedAt?: string;
  attachments: RelayAttachmentDescriptor[];
  /** Server-advertised request upload chunk size. Missing means legacy whole-file PUT. */
  uploadChunkBytes?: number;
  response?: {
    markdown: string;
    submittedBy?: string;
    submittedAt: string;
    attachments: RelayAttachmentDescriptor[];
  };
}

export interface RelayCreateTaskRequest {
  requestId?: string;
  title?: string;
  prompt: string;
  modelHint?: string;
  source?: string;
  sessionId?: string;
  localReceiver?: RelayLocalReceiver;
  expiresInMs?: number;
  attachments?: Array<{
    filename: string;
    displayPath?: string;
    mimeType?: string;
    contentBase64: string;
  }>;
}

export interface RelayCreateUploadTaskRequest extends Omit<RelayCreateTaskRequest, "attachments"> {
  attachments: Array<{
    filename: string;
    displayPath?: string;
    mimeType?: string;
    sizeBytes: number;
    sha256: string;
  }>;
}

export interface RelaySessionConfig {
  url: string;
  token: string;
  operatorUrl?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  expiresInMs?: number;
}

export interface RelayMetadata {
  config: Omit<RelaySessionConfig, "token"> & { tokenConfigured: boolean };
  /** Local canonical input fingerprint used to reject changed request-id reuse. */
  inputFingerprint?: string;
  taskId?: string;
  status?: RelayTaskStatus;
  submittedAt?: string;
  lastObservedAt?: string;
  completedAt?: string;
  operatorUrl?: string;
  resultTaskId?: string;
  resultDigest?: string;
  resultCommittedAt?: string;
  ackStatus?: "pending" | "succeeded";
}
