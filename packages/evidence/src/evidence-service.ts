import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256 } from '../../shared/src/canonical.js';
import { newId, nowIso } from '../../shared/src/ids.js';
import { MadeProofError } from '../../shared/src/errors.js';
import type { EvidenceItem } from '../../domain/src/types.js';

const MAX_INLINE_BYTES = 512 * 1024;

export class EvidenceService {
  constructor(private readonly dataDir: string) {}

  createInline(input: {
    workspaceId: string;
    runId: string;
    criterionId?: string;
    type: string;
    value: unknown;
    source: string;
    sourceActor: string;
    provenance: EvidenceItem['provenance'];
    mimeType?: string;
    observedAt?: string;
  }): EvidenceItem {
    const serialized = canonicalJson(input.value);
    const sizeBytes = Buffer.byteLength(serialized);
    if (sizeBytes > MAX_INLINE_BYTES)
      throw new MadeProofError(
        'EVIDENCE_TOO_LARGE',
        'Inline evidence exceeds 512 KiB; upload it as a file artifact',
        413,
      );
    const id = newId('evd');
    return {
      id,
      workspaceId: input.workspaceId,
      runId: input.runId,
      criterionId: input.criterionId ?? null,
      type: input.type,
      source: input.source,
      sourceActor: input.sourceActor,
      createdAt: nowIso(),
      observedAt: input.observedAt ?? nowIso(),
      contentHash: sha256(serialized),
      mimeType: input.mimeType ?? 'application/json',
      sizeBytes,
      storageLocation: `inline://${id}`,
      provenance: input.provenance,
      trustTier: this.trustTier(input.provenance),
      sanitizationState: 'SAFE',
      value: input.value,
    };
  }

  createFile(input: {
    workspaceId: string;
    runId: string;
    criterionId?: string;
    type: string;
    bytes: Uint8Array;
    extension: string;
    source: string;
    sourceActor: string;
    provenance: EvidenceItem['provenance'];
    mimeType: string;
  }): EvidenceItem {
    if (input.bytes.byteLength > 25 * 1024 * 1024)
      throw new MadeProofError('EVIDENCE_TOO_LARGE', 'Evidence file exceeds the 25 MiB limit', 413);
    if (!/^[a-z0-9]{1,8}$/i.test(input.extension))
      throw new MadeProofError('INVALID_FILE_EXTENSION', 'Evidence file extension is invalid', 422);
    const id = newId('evd');
    const dir = path.resolve(this.dataDir, 'evidence', input.runId);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.resolve(dir, `${id}.${input.extension.toLowerCase()}`);
    if (!target.startsWith(`${dir}${path.sep}`))
      throw new MadeProofError('PATH_TRAVERSAL', 'Evidence path escaped its storage boundary', 400);
    fs.writeFileSync(target, input.bytes, { mode: 0o600 });
    return {
      id,
      workspaceId: input.workspaceId,
      runId: input.runId,
      criterionId: input.criterionId ?? null,
      type: input.type,
      source: input.source,
      sourceActor: input.sourceActor,
      createdAt: nowIso(),
      observedAt: nowIso(),
      contentHash: sha256(input.bytes),
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      storageLocation: target,
      provenance: input.provenance,
      trustTier: this.trustTier(input.provenance),
      sanitizationState: 'SAFE',
    };
  }

  private trustTier(provenance: EvidenceItem['provenance']): number {
    return {
      SELF_REPORTED: 1,
      IMPORTED: 2,
      EXTERNAL_SIGNED: 3,
      OBSERVED: 4,
      EXECUTED_BY_MADEPROOF: 5,
    }[provenance];
  }
}
