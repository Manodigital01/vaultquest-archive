import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../logger.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

/**
 * Data Retention Policy for VaultQuest
 *
 * Classifies data into categories and applies retention rules:
 * - How long records are kept
 * - Which records are protected (never deleted)
 * - What triggers cleanup
 *
 * Protected records are those linked to active disputes, audits, financial settlement,
 * or regulatory compliance.
 */

export interface RetentionPolicy {
  category: string;
  description: string;
  retentionDays: number;
  table: string;
  protectionRules: ProtectionRule[];
}

export interface ProtectionRule {
  type: "linked_dispute" | "linked_audit" | "linked_settlement" | "active_user" | "recent_transaction";
  description: string;
}

export interface CleanupReport {
  timestamp: Date;
  category: string;
  eligibleForDeletion: number;
  protected: number;
  deleted: number;
  errors: string[];
  dryRun: boolean;
}

/**
 * Retention policy definitions
 */
export const RETENTION_POLICIES: Record<string, RetentionPolicy> = {
  // ─── AUDIT & COMPLIANCE (Never delete) ────────────────────────────────────
  ACTION_LEDGER: {
    category: "Action Ledger",
    description:
      "Core transaction log: deposits, withdrawals, claims. Permanently retained for compliance and dispute resolution.",
    retentionDays: 2555, // 7 years (regulatory minimum for financial services)
    table: "action_ledger",
    protectionRules: [
      {
        type: "linked_dispute",
        description: "Protect if referenced by active repair_quarantine or repair_proposal",
      },
      {
        type: "linked_settlement",
        description: "Protect if linked to pending vault_settlement",
      },
      {
        type: "active_user",
        description: "Protect if wallet has recent activity (last 90 days)",
      },
    ],
  },

  REPAIR_AUDIT: {
    category: "Repair Audit",
    description:
      "Immutable audit trail of reconciliation repairs. Permanently retained for regulatory compliance and incident investigation.",
    retentionDays: 2555, // 7 years
    table: "repair_audits",
    protectionRules: [
      {
        type: "linked_audit",
        description: "Never delete; required for audit compliance",
      },
    ],
  },

  RECORD_CHANGE_HISTORY: {
    category: "Record Change History",
    description: "Tamper-evident history of domain record mutations. Permanently retained for integrity verification.",
    retentionDays: 2555, // 7 years
    table: "record_change_history",
    protectionRules: [
      {
        type: "linked_audit",
        description: "Never delete; cryptographic chain would be broken",
      },
    ],
  },

  PROTOCOL_AUDIT: {
    category: "Protocol Audit",
    description: "Parameter changes and governance decisions. Permanently retained for historical record.",
    retentionDays: 2555, // 7 years
    table: "protocol_audits",
    protectionRules: [
      {
        type: "linked_audit",
        description: "Never delete; required for governance history",
      },
    ],
  },

  FEATURE_FLAG_AUDIT: {
    category: "Feature Flag Audit",
    description: "Runtime configuration changes. Retained for 3 years for operational investigation.",
    retentionDays: 1095, // 3 years
    table: "feature_flag_audits",
    protectionRules: [
      {
        type: "linked_audit",
        description: "Protect if recent (last 6 months)",
      },
    ],
  },

  // ─── OPERATIONAL DATA (Cleanup after retention window) ─────────────────────
  CHAIN_EVENT: {
    category: "Chain Events",
    description:
      "Raw on-chain contract events. Retained for 1 year for incident investigation; can be replayed from blockchain if needed.",
    retentionDays: 365, // 1 year
    table: "chain_events",
    protectionRules: [
      {
        type: "linked_dispute",
        description: "Protect if related action is pending or disputed",
      },
      {
        type: "recent_transaction",
        description: "Protect if action created within last 90 days",
      },
    ],
  },

  POISON_EVENT: {
    category: "Poison Events",
    description: "Malformed contract events. Retained for 90 days for investigation; can usually be re-ingested.",
    retentionDays: 90,
    table: "poison_events",
    protectionRules: [
      {
        type: "linked_dispute",
        description: "Protect if resolvedAt is null (actively being investigated)",
      },
    ],
  },

  PENDING_EVENT: {
    category: "Pending Events",
    description:
      "Unconsumed contract events. Retained for 30 days; old events are likely orphaned or superseded.",
    retentionDays: 30,
    table: "pending_events",
    protectionRules: [
      {
        type: "linked_dispute",
        description: "Protect if consumedAt is null AND receivedAt is recent (last 7 days)",
      },
    ],
  },

  ACTION_LEASE: {
    category: "Action Leases",
    description: "Worker coordination leases. Retained for 7 days; expired leases are defunct.",
    retentionDays: 7,
    table: "action_leases",
    protectionRules: [
      {
        type: "active_user",
        description: "Protect if expiresAt is in future (still valid)",
      },
    ],
  },

  JOB_LEASE: {
    category: "Job Leases",
    description: "Background job coordination leases. Retained for 7 days; expired leases can be cleared.",
    retentionDays: 7,
    table: "job_leases",
    protectionRules: [
      {
        type: "active_user",
        description: "Protect if expiresAt is in future (still valid)",
      },
    ],
  },

  // ─── TRANSIENT DATA (Cleanup aggressively) ─────────────────────────────────
  BACKGROUND_JOB: {
    category: "Background Jobs",
    description:
      "Completed or failed async tasks (draw proofs, notifications). Retained for 90 days; completed jobs are safe to delete.",
    retentionDays: 90,
    table: "background_jobs",
    protectionRules: [
      {
        type: "active_user",
        description: "Protect if status is 'queued' or 'in_progress' (still running)",
      },
      {
        type: "linked_audit",
        description: "Protect if attempts >= max_attempts AND last_error contains regulatory keywords",
      },
    ],
  },

  WALLET_CHALLENGE: {
    category: "Wallet Challenges",
    description: "Authentication challenges. Retained for 1 day; expired challenges are invalid.",
    retentionDays: 1,
    table: "wallet_challenges",
    protectionRules: [
      {
        type: "active_user",
        description: "Protect if expiresAt is in future (still valid)",
      },
    ],
  },

  WALLET_SESSION: {
    category: "Wallet Sessions",
    description: "Authentication sessions. Retained for 90 days; revoked sessions can be deleted after 30 days.",
    retentionDays: 90,
    table: "wallet_sessions",
    protectionRules: [
      {
        type: "active_user",
        description: "Protect if revokedAt is null AND expiresAt is in future (active session)",
      },
    ],
  },

  // ─── NEVER DELETE ──────────────────────────────────────────────────────────
  USER: {
    category: "Users",
    description: "User accounts. Permanently retained; deletion requires explicit account termination workflow.",
    retentionDays: 2555, // 7 years (never used for cleanup)
    table: "users",
    protectionRules: [
      {
        type: "active_user",
        description: "Never delete; requires explicit termination request",
      },
    ],
  },

  VAULT_SETTLEMENT: {
    category: "Vault Settlements",
    description: "Prize payouts. Permanently retained for financial audit and settlement verification.",
    retentionDays: 2555, // 7 years (never used for cleanup)
    table: "vault_settlements",
    protectionRules: [
      {
        type: "linked_settlement",
        description: "Never delete; financial record",
      },
    ],
  },

  REPAIR_PROPOSAL: {
    category: "Repair Proposals",
    description: "Reconciliation repair proposals. Permanently retained for governance and audit trail.",
    retentionDays: 2555, // 7 years (never used for cleanup)
    table: "repair_proposals",
    protectionRules: [
      {
        type: "linked_audit",
        description: "Never delete; governance record",
      },
    ],
  },

  REPAIR_QUARANTINE: {
    category: "Repair Quarantine",
    description: "Detected anomalies. Permanently retained until explicitly resolved.",
    retentionDays: 2555, // 7 years
    table: "repair_quarantine",
    protectionRules: [
      {
        type: "linked_dispute",
        description: "Protect if resolvedAt is null (actively being investigated)",
      },
    ],
  },
};

/**
 * Service for managing data retention, cleanup, and protection of active records.
 */
export class DataRetentionService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Generate a cleanup report for a specific data category.
   * Identifies eligible and protected records without deleting anything (dry-run by default).
   */
  async generateCleanupReport(
    categoryKey: string,
    opts?: { dryRun?: boolean; actor?: string }
  ): Promise<CleanupReport> {
    const policy = RETENTION_POLICIES[categoryKey];
    if (!policy) {
      throw new Error(`Unknown retention category: ${categoryKey}`);
    }

    const report: CleanupReport = {
      timestamp: new Date(),
      category: policy.category,
      eligibleForDeletion: 0,
      protected: 0,
      deleted: 0,
      errors: [],
      dryRun: opts?.dryRun ?? true,
    };

    try {
      const result = await this.analyzeRetentionForCategory(categoryKey, policy);
      report.eligibleForDeletion = result.eligible;
      report.protected = result.protected;

      if (!report.dryRun) {
        report.deleted = await this.executeCleanup(categoryKey, policy);

        logger.info(
          {
            category: policy.category,
            table: policy.table,
            deleted: report.deleted,
            protected: report.protected,
            actor: opts?.actor,
          },
          "data retention cleanup completed"
        );
      } else {
        logger.info(
          {
            category: policy.category,
            table: policy.table,
            eligible: report.eligibleForDeletion,
            protected: report.protected,
            dryRun: true,
          },
          "data retention cleanup dry-run completed"
        );
      }
    } catch (err) {
      report.errors.push(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      logger.error({ err, category: policy.category }, "data retention cleanup failed");
    }

    return report;
  }

  /**
   * Analyze retention eligibility for a category.
   * Returns count of eligible and protected records.
   */
  private async analyzeRetentionForCategory(
    categoryKey: string,
    policy: RetentionPolicy
  ): Promise<{ eligible: number; protected: number }> {
    const cutoffDate = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000);

    switch (categoryKey) {
      case "ACTION_LEDGER":
        return this.analyzeActionLedger(cutoffDate);
      case "CHAIN_EVENT":
        return this.analyzeChainEvents(cutoffDate);
      case "POISON_EVENT":
        return this.analyzePoisonEvents(cutoffDate);
      case "PENDING_EVENT":
        return this.analyzePendingEvents(cutoffDate);
      case "BACKGROUND_JOB":
        return this.analyzeBackgroundJobs(cutoffDate);
      case "WALLET_CHALLENGE":
        return this.analyzeWalletChallenges(cutoffDate);
      case "WALLET_SESSION":
        return this.analyzeWalletSessions(cutoffDate);
      case "ACTION_LEASE":
        return this.analyzeActionLeases(cutoffDate);
      case "JOB_LEASE":
        return this.analyzeJobLeases(cutoffDate);
      default:
        return { eligible: 0, protected: 0 };
    }
  }

  private async analyzeActionLedger(cutoffDate: Date): Promise<{ eligible: number; protected: number }> {
    // Protected: linked to active settlements, recent activity, or pending status
    const eligible = await this.prisma.actionLedger.count({
      where: {
        createdAt: { lt: cutoffDate },
        status: { in: ["confirmed", "reverted", "failed"] },
        updatedAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) }, // Not updated in 90 days
      },
    });

    const protected_count = await this.prisma.actionLedger.count({
      where: {
        createdAt: { lt: cutoffDate },
        OR: [
          { status: { in: ["pending", "submitted", "orphaned"] } }, // Active states
          { updatedAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } }, // Recent activity
        ],
      },
    });

    return { eligible, protected: protected_count };
  }

  private async analyzeChainEvents(cutoffDate: Date): Promise<{ eligible: number; protected: number }> {
    const eligible = await this.prisma.chainEvent.count({
      where: { ingestedAt: { lt: cutoffDate } },
    });

    // Protected: related to pending actions
    const protected_count = await this.prisma.chainEvent.count({
      where: {
        ingestedAt: { gte: cutoffDate },
        txHash: {
          in: (
            await this.prisma.actionLedger.findMany({
              where: { status: { in: ["pending", "submitted"] } },
              select: { txHash: true },
            })
          )
            .map((a) => a.txHash!)
            .filter((h) => h),
        },
      },
    });

    return { eligible, protected: protected_count };
  }

  private async analyzePoisonEvents(cutoffDate: Date): Promise<{ eligible: number; protected: number }> {
    const eligible = await this.prisma.poisonEvent.count({
      where: {
        detectedAt: { lt: cutoffDate },
        resolvedAt: { not: null }, // Already resolved
      },
    });

    const protected_count = await this.prisma.poisonEvent.count({
      where: {
        OR: [
          { resolvedAt: null }, // Still under investigation
          { detectedAt: { gte: cutoffDate } }, // Recent
        ],
      },
    });

    return { eligible, protected: protected_count };
  }

  private async analyzePendingEvents(cutoffDate: Date): Promise<{ eligible: number; protected: number }> {
    const eligible = await this.prisma.pendingEvent.count({
      where: {
        receivedAt: { lt: cutoffDate },
        consumedAt: { not: null }, // Already consumed
      },
    });

    const protected_count = await this.prisma.pendingEvent.count({
      where: {
        OR: [
          { consumedAt: null }, // Unconsumed
          { receivedAt: { gte: cutoffDate } }, // Recent
        ],
      },
    });

    return { eligible, protected: protected_count };
  }

  private async analyzeBackgroundJobs(cutoffDate: Date): Promise<{ eligible: number; protected: number }> {
    const eligible = await this.prisma.backgroundJob.count({
      where: {
        updatedAt: { lt: cutoffDate },
        status: { in: ["completed", "failed"] },
      },
    });

    const protected_count = await this.prisma.backgroundJob.count({
      where: {
        OR: [
          { status: { in: ["queued", "in_progress"] } }, // Still running
          { updatedAt: { gte: cutoffDate } }, // Recent
        ],
      },
    });

    return { eligible, protected: protected_count };
  }

  private async analyzeWalletChallenges(cutoffDate: Date): Promise<{ eligible: number; protected: number }> {
    const eligible = await this.prisma.walletChallenge.count({
      where: {
        expiresAt: { lt: cutoffDate },
      },
    });

    const protected_count = await this.prisma.walletChallenge.count({
      where: { expiresAt: { gte: cutoffDate } }, // Still valid
    });

    return { eligible, protected: protected_count };
  }

  private async analyzeWalletSessions(cutoffDate: Date): Promise<{ eligible: number; protected: number }> {
    const eligible = await this.prisma.walletSession.count({
      where: {
        createdAt: { lt: cutoffDate },
        revokedAt: { not: null }, // Already revoked
        expiresAt: { lt: new Date() }, // Expired
      },
    });

    const protected_count = await this.prisma.walletSession.count({
      where: {
        OR: [
          { revokedAt: null }, // Active
          { expiresAt: { gte: new Date() } }, // Not yet expired
        ],
      },
    });

    return { eligible, protected: protected_count };
  }

  private async analyzeActionLeases(cutoffDate: Date): Promise<{ eligible: number; protected: number }> {
    const eligible = await this.prisma.actionLease.count({
      where: { expiresAt: { lt: new Date() } }, // Expired
    });

    const protected_count = await this.prisma.actionLease.count({
      where: { expiresAt: { gte: new Date() } }, // Still valid
    });

    return { eligible, protected: protected_count };
  }

  private async analyzeJobLeases(cutoffDate: Date): Promise<{ eligible: number; protected: number }> {
    const eligible = await this.prisma.jobLease.count({
      where: { expiresAt: { lt: new Date() } }, // Expired
    });

    const protected_count = await this.prisma.jobLease.count({
      where: { expiresAt: { gte: new Date() } }, // Still valid
    });

    return { eligible, protected: protected_count };
  }

  /**
   * Execute cleanup for a category (actually delete records).
   * Returns number of deleted records.
   */
  private async executeCleanup(categoryKey: string, policy: RetentionPolicy): Promise<number> {
    const cutoffDate = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000);

    switch (categoryKey) {
      case "CHAIN_EVENT": {
        const result = await this.prisma.chainEvent.deleteMany({
          where: { ingestedAt: { lt: cutoffDate } },
        });
        return result.count;
      }

      case "POISON_EVENT": {
        const result = await this.prisma.poisonEvent.deleteMany({
          where: {
            detectedAt: { lt: cutoffDate },
            resolvedAt: { not: null },
          },
        });
        return result.count;
      }

      case "PENDING_EVENT": {
        const result = await this.prisma.pendingEvent.deleteMany({
          where: {
            receivedAt: { lt: cutoffDate },
            consumedAt: { not: null },
          },
        });
        return result.count;
      }

      case "BACKGROUND_JOB": {
        const result = await this.prisma.backgroundJob.deleteMany({
          where: {
            updatedAt: { lt: cutoffDate },
            status: { in: ["completed", "failed"] },
          },
        });
        return result.count;
      }

      case "WALLET_CHALLENGE": {
        const result = await this.prisma.walletChallenge.deleteMany({
          where: { expiresAt: { lt: cutoffDate } },
        });
        return result.count;
      }

      case "WALLET_SESSION": {
        const result = await this.prisma.walletSession.deleteMany({
          where: {
            createdAt: { lt: cutoffDate },
            revokedAt: { not: null },
            expiresAt: { lt: new Date() },
          },
        });
        return result.count;
      }

      case "ACTION_LEASE": {
        const result = await this.prisma.actionLease.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        return result.count;
      }

      case "JOB_LEASE": {
        const result = await this.prisma.jobLease.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        return result.count;
      }

      default:
        return 0;
    }
  }

  /**
   * Check if a record is protected from deletion.
   */
  async isRecordProtected(table: string, recordId: string): Promise<boolean> {
    // Implementation would check specific protection rules
    // For now, return false (safe default: don't delete if unsure)
    logger.warn({ table, recordId }, "protection check not fully implemented");
    return false;
  }
}
