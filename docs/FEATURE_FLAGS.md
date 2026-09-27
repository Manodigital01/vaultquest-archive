# Feature Flags: Staged Rollout and Emergency Rollback

This document explains VaultQuest's feature flag system for managing high-risk behavior changes with runtime toggles, staged rollout, and emergency rollback capability.

## Overview

Feature flags allow maintainers to:
- **Stage rollout**: Enable new logic incrementally across environments
- **Compare behavior**: Run old and new paths side-by-side before full commitment
- **Emergency rollback**: Disable broken features without redeployment
- **Scope toggles**: Apply flags globally, per-vault, or per-wallet

All flags default to the **safer behavior** (disabled for new features, enabled for safeguards) to ensure safe operation when configuration is missing.

## Typed Feature Flag Definitions

Feature flags are defined in `backend/src/services/featureFlagService.ts`:

```typescript
export const FEATURE_FLAGS = {
  /**
   * Controls prize draw execution. When disabled (default), draw_winner events are logged
   * but proof generation and prize distribution are skipped. Safe default: disabled.
   * Use case: Staged rollout of draw logic, emergency rollback if draw mechanism breaks.
   */
  PRIZE_DRAW_EXECUTION: "prize-draw-execution",

  /**
   * Controls vault reconciliation repair plan execution. When disabled (default),
   * detected drift is logged and repair steps proposed but NOT applied. Safe default: disabled.
   * Use case: Staged rollout of reconciliation fixes, prevents accidental state mutations.
   */
  RECONCILIATION_AUTO_REPAIR: "reconciliation-auto-repair",

  /**
   * Controls withdrawal processing submission. When disabled (default), withdrawal
   * actions remain pending and are never submitted to chain. Safe default: disabled.
   * Use case: Emergency stop for withdrawal flow, staged rollout of new submission logic.
   */
  WITHDRAWAL_SUBMISSION_ENABLED: "withdrawal-submission-enabled",
};
```

### Adding New Flags

To add a new feature flag:

1. Define it in `FEATURE_FLAGS` constant with a descriptive comment explaining:
   - What behavior the flag controls
   - What the safe default is and why
   - Example use cases

2. Update `FeatureFlagKey` type union if needed

3. Apply the flag in the appropriate service's conditional logic

Example:
```typescript
// In FeatureFlagService
CANCEL_ORDERS_ENABLED: "cancel-orders-enabled", // Safe default: disabled

// In OrderService.cancelOrder()
if (this.featureFlagService) {
  const isEnabled = await this.featureFlagService.isEnabled("cancel-orders-enabled");
  if (!isEnabled) {
    this.logger.info({ orderId }, "order cancellation skipped: flag disabled");
    return null;
  }
}
```

## Safe Defaults

Missing configuration always falls back to the **safer behavior**:

- **New features** (e.g., `PRIZE_DRAW_EXECUTION`): Default to **disabled**
  - No proof generation happens until flag is explicitly enabled
  - Prevents unvetted logic from running in production

- **Emergency safeguards**: Would default to **enabled** (hypothetically)
  - But in current set, all flags follow the conservative default

- **Database errors**: If flag service fails or database is unreachable, flag is treated as **disabled**
  - Ensures safer degradation instead of allowing risky operations

## Server-Side Checks

All feature flag checks are **server-side only**, protected by:

1. **Database-backed state**: Flags stored in PostgreSQL `feature_flags` table
   - Runtime changes take effect immediately via cache invalidation
   - No client-side flag parity required

2. **Permission-based updates**: Only authenticated backend operators can modify flags
   - Protected by RBAC middleware (see `backend/src/middleware/rbac.js`)
   - Audit trail recorded for compliance (see `feature_flag_audits` table)

3. **Type-safe checks**: Flags checked via `FeatureFlagService.isEnabled()` before sensitive operations
   - TypeScript ensures only known flags can be referenced
   - No magic strings

## Staged Rollout Workflow

### Step 1: Deploy New Code with Flag Protection

Wrap high-risk logic in a flag check. Example for `PRIZE_DRAW_EXECUTION`:

```typescript
// In DrawProofService.generateProofImpl()
if (this.featureFlagService) {
  const isEnabled = await this.featureFlagService.isEnabled(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION);
  if (!isEnabled) {
    this.logger.info({ actionId }, "draw proof generation skipped: flag disabled");
    return null;
  }
}
// ... rest of proof generation logic
```

When deployed, the flag is **disabled** (safe default), so the new logic does **not** run.

### Step 2: Enable in Development/Staging

Enable the flag in non-production to test behavior:

```bash
# Via SQL directly (for manual testing)
INSERT INTO feature_flags (key, enabled, scope, description)
VALUES ('prize-draw-execution', true, 'global', 'Staging: testing prize draw proofs')
ON CONFLICT (key, scope) DO UPDATE SET enabled = true;
```

Or via backend admin API (when implemented):
```bash
POST /admin/feature-flags
{
  "key": "prize-draw-execution",
  "enabled": true,
  "scope": "global",
  "reason": "Staging: enabling draw logic for QA testing"
}
```

### Step 3: Run Verification Tests

Ensure new logic works correctly:

```bash
# Run feature flag tests
npm test -- featureFlagService.spec.ts
npm test -- drawProofService-featureFlag.spec.ts

# Run integration tests with flag enabled
FEATURE_FLAGS='prize-draw-execution=true' npm test
```

### Step 4: Roll Out to Production (Optional Scoping)

Enable flag in production:

#### Global Rollout (All Vaults)
```sql
INSERT INTO feature_flags (key, enabled, scope)
VALUES ('prize-draw-execution', true, 'global')
ON CONFLICT (key, scope) DO UPDATE SET enabled = true;
```

#### Gradual Rollout (Per-Vault)
```sql
-- Enable for vault A only (canary)
INSERT INTO feature_flags (key, enabled, scope)
VALUES ('prize-draw-execution', true, 'vault:GBD3...VAULT_A_ID')
ON CONFLICT (key, scope) DO UPDATE SET enabled = true;

-- Monitor for issues...
-- Then roll out to vault B
INSERT INTO feature_flags (key, enabled, scope)
VALUES ('prize-draw-execution', true, 'vault:GBD3...VAULT_B_ID')
ON CONFLICT (key, scope) DO UPDATE SET enabled = true;
```

### Step 5: Monitor Behavior

Watch logs and metrics for the flagged feature:

```bash
# Tail logs for prize draw activity
docker logs <backend-container> | grep "draw_proof"

# Check for errors
SELECT * FROM feature_flag_audits 
WHERE flag_key = 'prize-draw-execution' 
ORDER BY created_at DESC LIMIT 10;
```

## Emergency Rollback Workflow

If a flagged feature exhibits issues in production:

### Immediate: Disable the Flag

```sql
UPDATE feature_flags 
SET enabled = false 
WHERE key = 'prize-draw-execution' AND scope = 'global';

INSERT INTO feature_flag_audits (flag_key, previous_value, new_value, actor, reason)
VALUES ('prize-draw-execution', true, false, 'operator-123', 'Emergency rollback: draw logic causing invalid proofs');
```

Or via API:
```bash
POST /admin/feature-flags/disable
{
  "key": "prize-draw-execution",
  "reason": "Emergency rollback: draw logic causing invalid proofs"
}
```

**Effect**: Immediately, all new prize draw proof generation is **skipped**. No redeploy needed.

### Verify Rollback

1. **Check flag status**:
   ```sql
   SELECT * FROM feature_flags WHERE key = 'prize-draw-execution';
   ```

2. **Confirm new proof generation stopped**:
   ```sql
   -- Should see logs indicating flag disabled
   SELECT * FROM action_ledger 
   WHERE action_type = 'select_winner' 
     AND status = 'confirmed'
     AND created_at > NOW() - INTERVAL '5 minutes'
   ORDER BY created_at DESC;
   ```

3. **Check audit trail**:
   ```sql
   SELECT * FROM feature_flag_audits 
   WHERE flag_key = 'prize-draw-execution'
   ORDER BY created_at DESC LIMIT 5;
   ```

### Diagnose Root Cause

While the flag is disabled:
- Review backend logs for errors during proof generation
- Check on-chain state for discrepancies
- Run integration tests locally with flag disabled vs. enabled

### Re-Enable After Fix

Once root cause is fixed and verified in staging:

```sql
UPDATE feature_flags 
SET enabled = true 
WHERE key = 'prize-draw-execution' AND scope = 'global';

INSERT INTO feature_flag_audits (flag_key, previous_value, new_value, actor, reason)
VALUES ('prize-draw-execution', false, true, 'operator-456', 'Re-enabled after fix: PR #5432 merged');
```

## Testing

### Unit Tests

Tests for `FeatureFlagService` verify:
- ✓ Enabled flags return true
- ✓ Disabled flags return false
- ✓ Missing config falls back to safe default (false)
- ✓ Database errors fall back to safe default
- ✓ Scoped flags (vault, wallet) are correctly resolved
- ✓ Cache invalidation works after flag updates

```bash
npm test -- featureFlagService.spec.ts
```

### Integration Tests with Flag

Tests for services using flags verify:
- ✓ Flag disabled: risky logic is skipped, null returned
- ✓ Flag disabled: no database mutations occur
- ✓ Flag enabled: risky logic proceeds
- ✓ Flag enabled: side effects (proof generation, repairs) occur
- ✓ Service without flag injected: defaults to safe behavior (skip)
- ✓ Flag lookup failure: defaults to safe behavior

```bash
npm test -- drawProofService-featureFlag.spec.ts
```

### Missing Configuration Test

Verify that flagged services work correctly when feature flag table doesn't exist or has no rows:

```bash
# In test setup, simulate missing table
beforeEach(() => {
  mockPrisma.featureFlag.findUnique.mockRejectedValue(
    new Error("relation \"feature_flags\" does not exist")
  );
});

// Service should default to safe behavior
const result = await service.generateProof({ actionId: "test" });
expect(result).toBeNull(); // Safe: no proof generated
```

## Configuration

### Environment Variables

No environment variables are required for feature flags; they are purely database-driven at runtime. However, for automated deployments:

```bash
# Optional: seed initial flag state from env (not implemented)
FEATURE_FLAGS_SEED='prize-draw-execution=false,reconciliation-auto-repair=false'
```

### Database Configuration

Feature flags are stored in PostgreSQL. Ensure migration is applied:

```bash
npm run migrate:prod
```

This creates:
- `feature_flags` table with `(key, scope)` unique constraint
- `feature_flag_audits` table for immutable change log
- Indexes on `key`, `scope`, and `created_at` for fast lookups

### Cache Configuration

The `FeatureFlagService` caches flag state for 30 seconds to reduce database load:

```typescript
private readonly CACHE_TTL_MS = 30_000; // 30s
```

To adjust, update the constant in `backend/src/services/featureFlagService.ts`.

## Examples

### Example 1: Staged Rollout of Prize Draw

**Day 1**: Deploy new draw proof logic (flag disabled)
- Code is in place but inactive
- No prizes are drawn or proved

**Day 2**: Enable flag in staging
- Verify proofs generate correctly
- Run end-to-end tests with real contract data

**Day 3**: Enable flag for vault A in production (canary)
- 5% of users' draws now have proofs
- Monitor error rates, proof validity

**Day 4**: Enable flag globally after monitoring succeeds
- All prize draws now have cryptographic proofs

**Day 7**: If issues found, emergency disable
- Flag set to false immediately
- All new draws revert to no proof (safe state)
- Investigate before re-enabling

### Example 2: Gradual Withdrawal Enablement

Use per-wallet scoping to roll out withdrawal functionality to power users first:

```sql
-- Enable for operator wallet (testing)
INSERT INTO feature_flags (key, enabled, scope)
VALUES ('withdrawal-submission-enabled', true, 'wallet:GBD3...OPERATOR');

-- Enable for 10% of user population (random sample)
INSERT INTO feature_flags (key, enabled, scope)
VALUES ('withdrawal-submission-enabled', true, 'wallet:GBD3...USER_1');
INSERT INTO feature_flags (key, enabled, scope)
VALUES ('withdrawal-submission-enabled', true, 'wallet:GBD3...USER_2');
-- ... more users

-- Monitor...

-- Then enable globally
INSERT INTO feature_flags (key, enabled, scope)
VALUES ('withdrawal-submission-enabled', true, 'global');
```

## API Reference

### FeatureFlagService

```typescript
class FeatureFlagService {
  /**
   * Check if a feature flag is enabled.
   * @param key - Feature flag key from FEATURE_FLAGS
   * @param scope - Optional scope: { global?, vault?, wallet? }
   * @returns true if enabled, false if disabled or missing (safe default)
   */
  async isEnabled(key: FeatureFlagKey, scope?: FeatureFlagScope): Promise<boolean>;

  /**
   * Set a feature flag value and record audit trail.
   * Server-side only; protected by RBAC.
   */
  async setFlag(
    key: FeatureFlagKey,
    enabled: boolean,
    opts?: { actor?: string; reason?: string; scope?: string }
  ): Promise<void>;

  /**
   * Clear the flag cache (useful after bulk migrations).
   */
  clearCache(): void;
}
```

### Database Schema

```sql
-- Feature flags
CREATE TABLE feature_flags (
  id UUID PRIMARY KEY,
  key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  scope TEXT NOT NULL DEFAULT 'global',
  metadata JSONB,
  updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  UNIQUE (key, scope)
);

-- Audit trail for changes
CREATE TABLE feature_flag_audits (
  id UUID PRIMARY KEY,
  flag_key TEXT NOT NULL,
  previous_value BOOLEAN NOT NULL,
  new_value BOOLEAN NOT NULL,
  actor TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ
);
```

## Troubleshooting

### Flag changes not taking effect

**Issue**: Disabled flag but behavior unchanged

**Solution**: Flag cache TTL is 30 seconds. Either wait or call `FeatureFlagService.clearCache()` to invalidate immediately.

### Missing `feature_flags` table error

**Issue**: `relation "feature_flags" does not exist`

**Solution**: Apply database migration:
```bash
npm run migrate:prod
```

### Flag always returns false even when set to true

**Issue**: Database write succeeded but flag still disabled

**Solution**:
1. Verify flag was written to correct `scope`:
   ```sql
   SELECT * FROM feature_flags WHERE key = 'prize-draw-execution';
   ```

2. Check if a more specific scope (e.g., `global`) is overriding a vault-scoped flag

3. Verify timezone: flag updates are recorded in UTC

### Performance impact

**Issue**: Flag lookups slowing down request handling

**Solution**: Cache TTL is conservative at 30 seconds. Consider:
- Increasing `CACHE_TTL_MS` if flag changes are infrequent
- Pre-loading flags at app startup (not currently implemented)

## Migration Path for Existing Deployments

For deployments that existed before feature flags were introduced:

1. **Apply migration** (`20260927000001_add_feature_flags`):
   ```bash
   npm run migrate:prod
   ```

2. **Seed safe default flags** (optional, for audit clarity):
   ```sql
   INSERT INTO feature_flags (key, enabled, scope, description)
   VALUES
     ('prize-draw-execution', false, 'global', 'Prize draw proof generation [Safe Default: Disabled]'),
     ('reconciliation-auto-repair', false, 'global', 'Vault reconciliation auto-repair [Safe Default: Disabled]'),
     ('withdrawal-submission-enabled', false, 'global', 'Withdrawal submission to chain [Safe Default: Disabled]');
   ```

3. **No code changes required** for existing deployments:
   - Services check flags at runtime
   - Missing flag rows default to false (safe)
   - No breaking changes

## See Also

- `backend/src/services/featureFlagService.ts` — Service implementation
- `backend/src/services/drawProofService.ts` — Example usage (prize draws)
- `backend/tests/featureFlagService.spec.ts` — Unit tests
- `backend/tests/drawProofService-featureFlag.spec.ts` — Integration tests
