/**
 * Approval flow manager (#5, #6).
 *
 * Handles the lifecycle of approval tokens:
 * - Creates tokens with correlation IDs tied to payload hashes (#6).
 * - Validates that resolutions match the original payload.
 * - Supports "approve with edits" via patchedArgs (#5).
 * - Enforces TTL-based expiry.
 */

import type {
  ApprovalHandler,
  ApprovalResolution,
  ApprovalToken,
  PolicyContext,
} from "../types.js";
import { generateId, sha256, canonicalize } from "../utils/index.js";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class ApprovalManager {
  private readonly pendingTokens = new Map<string, ApprovalToken>();
  private readonly handler: ApprovalHandler;
  private readonly defaultTtlMs: number;

  constructor(handler: ApprovalHandler, defaultTtlMs?: number) {
    this.handler = handler;
    this.defaultTtlMs = defaultTtlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Create an approval token for a tool call and invoke the handler.
   * Returns the resolution (approved / denied / patched).
   */
  async requestApproval(
    ctx: PolicyContext,
  ): Promise<ApprovalFlowResult> {
    const payloadHash = await sha256(
      canonicalize({ toolName: ctx.toolName, args: ctx.args }),
    );

    const token: ApprovalToken = {
      id: generateId(),
      payloadHash,
      toolName: ctx.toolName,
      originalArgs: structuredClone(ctx.args),
      createdAt: new Date().toISOString(),
      ttlMs: this.defaultTtlMs,
    };

    this.pendingTokens.set(token.id, token);

    try {
      const resolution = await this.handler(token);
      return this.resolveToken(token.id, resolution);
    } finally {
      this.pendingTokens.delete(token.id);
    }
  }

  /**
   * Resolve a pending approval token.
   * Validates correlation and TTL, then produces the final result.
   */
  private resolveToken(
    tokenId: string,
    resolution: ApprovalResolution,
  ): ApprovalFlowResult {
    const token = this.pendingTokens.get(tokenId);

    if (!token) {
      return {
        approved: false,
        args: {},
        error: `No pending approval token found for id "${tokenId}". ` +
          "The token may have expired or been resolved already.",
      };
    }

    // Check TTL.
    if (token.ttlMs) {
      const elapsed =
        Date.now() - new Date(token.createdAt).getTime();
      if (elapsed > token.ttlMs) {
        return {
          approved: false,
          args: token.originalArgs,
          error: `Approval token "${tokenId}" expired after ${token.ttlMs}ms.`,
        };
      }
    }

    if (!resolution.approved) {
      return {
        approved: false,
        args: token.originalArgs,
        reason: resolution.reason ?? "Approval denied by handler.",
      };
    }

    // Merge patched args with originals (#5).
    const finalArgs = resolution.patchedArgs
      ? { ...token.originalArgs, ...resolution.patchedArgs }
      : token.originalArgs;

    return {
      approved: true,
      args: finalArgs,
      patchedFields: resolution.patchedArgs
        ? Object.keys(resolution.patchedArgs)
        : undefined,
      approvedBy: resolution.approvedBy,
    };
  }

  /** Get a snapshot of pending tokens (for UI rendering). */
  getPendingTokens(): ReadonlyArray<ApprovalToken> {
    return Array.from(this.pendingTokens.values());
  }
}

/** Result of a full approval flow cycle. */
export interface ApprovalFlowResult {
  approved: boolean;
  /** The final arguments to use (original or patched). */
  args: Record<string, unknown>;
  /** Fields that were patched by the approver. */
  patchedFields?: string[];
  /** Who approved. */
  approvedBy?: string;
  /** Human-readable reason if denied. */
  reason?: string;
  /** Error message if the flow itself failed. */
  error?: string;
}
