# Guards — `ai-tool-guard/guards`

The guards module provides four categories of runtime protection: argument-level
validation, prompt injection detection, output egress filtering, and rate limiting
with concurrency control.

```ts
import {
  zodGuard,
  allowlist,
  denylist,
  regexGuard,
  piiGuard,
  evaluateArgGuards,
  checkInjection,
  secretsFilter,
  piiOutputFilter,
  customFilter,
  runOutputFilters,
  RateLimiter,
} from "ai-tool-guard/guards";
```

---

## Argument Guards

Argument guards run before policy evaluation and reject calls whose arguments
fail validation.

### `zodGuard`

```ts
function zodGuard(config: ZodArgGuard): ArgGuard
```

Create an `ArgGuard` backed by a Zod schema. The field value is parsed with
`schema.safeParse()`; any Zod issues are joined and returned as the failure
message.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `config.field` | `string` | Yes | Dot-path to the argument field (e.g. `"user.email"`) or `"*"` for the whole args object |
| `config.schema` | `z.ZodType` | Yes | Zod schema to validate the field value against |

**Returns** `ArgGuard`

**Example**

```ts
import { z } from "zod";

const guard = zodGuard({
  field: "query",
  schema: z.string().min(1).max(500),
});
```

---

### `allowlist`

```ts
function allowlist(field: string, allowed: readonly unknown[]): ArgGuard
```

Create an `ArgGuard` that rejects any value not present in the allowed list.
Comparison uses `Array.prototype.includes` (strict equality).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `field` | `string` | Yes | Argument field to check |
| `allowed` | `readonly unknown[]` | Yes | Set of permitted values |

**Returns** `ArgGuard`

---

### `denylist`

```ts
function denylist(field: string, denied: readonly unknown[]): ArgGuard
```

Create an `ArgGuard` that rejects any value present in the denied list.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `field` | `string` | Yes | Argument field to check |
| `denied` | `readonly unknown[]` | Yes | Set of forbidden values |

**Returns** `ArgGuard`

---

### `regexGuard`

```ts
function regexGuard(
  field: string,
  pattern: RegExp,
  opts?: { mustMatch?: boolean; message?: string },
): ArgGuard
```

Create an `ArgGuard` that validates a string field against a regular expression.
Non-string values always fail.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `field` | `string` | Yes | Argument field to test |
| `pattern` | `RegExp` | Yes | Pattern to test against |
| `opts.mustMatch` | `boolean` | No | When `true`, the value must match. When `false`, matching is forbidden. Default: `true` |
| `opts.message` | `string` | No | Custom failure message |

**Returns** `ArgGuard`

---

### `piiGuard`

```ts
function piiGuard(
  field: string,
  opts?: { allowedTypes?: string[] },
): ArgGuard
```

Create an `ArgGuard` that scans a string field for common PII patterns. Detected
patterns are `"email"`, `"ssn"`, `"credit-card"`, `"phone-us"`, and
`"ip-address"`. Credit card numbers are additionally validated with a Luhn check.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `field` | `string` | Yes | Argument field to scan |
| `opts.allowedTypes` | `string[]` | No | PII type names to skip (e.g. `["email"]` to allow email addresses) |

**Returns** `ArgGuard`

---

### `evaluateArgGuards`

```ts
async function evaluateArgGuards(
  guards: ArgGuard[],
  ctx: PolicyContext,
): Promise<ArgGuardResult>
```

Run all argument guards against the tool call context. Guards are evaluated in
order; all guards run even if earlier ones fail, collecting all violations.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `guards` | `ArgGuard[]` | Yes | Guards to evaluate |
| `ctx` | `PolicyContext` | Yes | Tool call context providing `args` and other metadata |

**Returns** `Promise<ArgGuardResult>`

---

## Injection Detection

### `checkInjection`

```ts
async function checkInjection(
  ctx: PolicyContext,
  config: InjectionDetectorConfig,
): Promise<InjectionCheckResult>
```

Scan tool arguments for prompt injection patterns using either a built-in
heuristic detector or a custom scoring function.

The built-in detector flattens all string values in `args` into a single text
blob and checks against patterns including instruction overrides, role hijacking,
delimiter injection, exfiltration attempts, and encoded payloads. It also flags
arguments with total string length exceeding 5,000 characters.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ctx` | `PolicyContext` | Yes | Tool call context |
| `config` | `InjectionDetectorConfig` | Yes | Detection configuration |

**Returns** `Promise<InjectionCheckResult>`

---

## Output Filters

Output filters run after tool execution and can redact or block the result before
it reaches the model.

### `secretsFilter`

```ts
function secretsFilter(extraRules?: RedactionRule[]): OutputFilter
```

Create an output filter that redacts common secrets from string output using
regex-based replacement. Built-in patterns cover AWS access keys, GitHub tokens,
JWTs, generic API keys, Bearer tokens, and PEM private keys.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `extraRules` | `RedactionRule[]` | No | Additional redaction rules appended to the built-in set |

**Returns** `OutputFilter`

---

### `piiOutputFilter`

```ts
function piiOutputFilter(opts?: { allowedTypes?: string[] }): OutputFilter
```

Create an output filter that redacts PII from string output. Covers email
addresses, SSNs, US phone numbers, and credit card numbers (Luhn-validated).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `opts.allowedTypes` | `string[]` | No | PII type names to skip: `"email"`, `"ssn"`, `"phone"`, `"credit-card"` |

**Returns** `OutputFilter`

---

### `customFilter`

```ts
function customFilter(
  name: string,
  fn: (result: unknown, ctx: PolicyContext) => Promise<OutputFilterResult>,
): OutputFilter
```

Wrap an arbitrary async function as an `OutputFilter`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Identifier used in logging and `OutputFilterChainResult.blockedBy` |
| `fn` | `(result: unknown, ctx: PolicyContext) => Promise<OutputFilterResult>` | Yes | Filter implementation |

**Returns** `OutputFilter`

**Example**

```ts
const classificationFilter = customFilter("classification", async (result, ctx) => {
  const sensitive = await detectSensitiveData(result);
  if (sensitive) {
    return { verdict: "block", output: null };
  }
  return { verdict: "pass", output: result };
});
```

---

### `runOutputFilters`

```ts
async function runOutputFilters(
  filters: OutputFilter[],
  result: unknown,
  ctx: PolicyContext,
): Promise<OutputFilterChainResult>
```

Execute a chain of output filters sequentially. Each filter receives the output
of the previous filter. If any filter returns verdict `"block"`, the chain stops
immediately and the result is suppressed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `filters` | `OutputFilter[]` | Yes | Ordered list of filters to run |
| `result` | `unknown` | Yes | Raw tool output |
| `ctx` | `PolicyContext` | Yes | Tool call context forwarded to each filter |

**Returns** `Promise<OutputFilterChainResult>`

---

## Rate Limiting

### `RateLimiter`

Sliding-window rate limiter with per-tool state and optional concurrency control.
Supports two backpressure strategies: `"reject"` (return immediately with an
error) and `"queue"` (wait until a slot becomes available).

#### Constructor

```ts
new RateLimiter()
```

No constructor parameters. State is maintained internally per tool name.

#### Methods

##### `acquire`

```ts
async acquire(
  toolName: string,
  config: RateLimitConfig,
  maxConcurrency?: number,
): Promise<RateLimitAcquireResult>
```

Attempt to acquire a rate limit slot for the given tool.

- Slides the window by discarding timestamps older than `config.windowMs`.
- Checks call count against `config.maxCalls`.
- Checks active calls against `maxConcurrency` if provided.
- When `config.strategy === "queue"`, blocks until a slot is available instead
  of returning `allowed: false`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `toolName` | `string` | Yes | Tool identifier |
| `config` | `RateLimitConfig` | Yes | Rate limit settings |
| `maxConcurrency` | `number` | No | Maximum simultaneous active calls |

**Returns** `Promise<RateLimitAcquireResult>`

##### `release`

```ts
release(toolName: string): void
```

Decrement the active call counter after tool execution completes. Also wakes one
queued caller if any are waiting.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `toolName` | `string` | Yes | Tool identifier |

##### `getState`

```ts
getState(toolName: string): RateLimitState | undefined
```

Return a reference to the current sliding-window state for a tool. Returns
`undefined` if the tool has not yet been seen.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `toolName` | `string` | Yes | Tool identifier |

**Returns** `RateLimitState | undefined`

##### `reset`

```ts
reset(): void
```

Clear all rate limit state and reject any queued waiters with an error. Intended
for testing.

---

## Result Types

### `ArgGuardResult`

Returned by `evaluateArgGuards()`.

| Field | Type | Description |
|---|---|---|
| `passed` | `boolean` | `true` when all guards passed (no violations) |
| `violations` | `Array<{ field: string; message: string }>` | List of validation failures with field path and reason |

---

### `InjectionCheckResult`

Returned by `checkInjection()`.

| Field | Type | Description |
|---|---|---|
| `score` | `number` | Suspicion score from 0 to 1 |
| `suspected` | `boolean` | `true` when `score >= config.threshold` |
| `action` | `"downgrade" \| "deny" \| "log"` | The configured action at detection time |
| `verdictOverride` | `DecisionVerdict` | How the policy verdict should be modified; `undefined` if no override |

---

### `RedactionRule`

Pattern-based redaction rule used by `secretsFilter()` and `piiOutputFilter()`.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Human-readable identifier for logging |
| `pattern` | `RegExp` | Yes | Regex to match sensitive content (should use the `g` flag for replacement) |
| `replacement` | `string` | No | Replacement string. Default: `"[REDACTED]"` |
| `validate` | `(match: string) => boolean` | No | Optional post-match validator; return `true` to confirm the match is real (used for Luhn checks) |

---

### `OutputFilterChainResult`

Returned by `runOutputFilters()`.

| Field | Type | Description |
|---|---|---|
| `output` | `unknown` | The final (possibly filtered) tool output |
| `redactedFields` | `string[]` | All fields redacted across all filters, prefixed with the filter name (e.g. `"secrets-filter:aws-key"`) |
| `blocked` | `boolean` | `true` when a filter returned verdict `"block"` |
| `blockedBy` | `string` | Name of the filter that blocked the output; only present when `blocked` is `true` |

---

### `RateLimitAcquireResult`

Returned by `RateLimiter.acquire()`.

| Field | Type | Description |
|---|---|---|
| `allowed` | `boolean` | Whether the call is permitted to proceed |
| `reason` | `string` | Human-readable reason for rejection; only present when `allowed` is `false` |
| `retryAfterMs` | `number` | Milliseconds until the oldest window entry expires; only present on rate limit (not concurrency) rejection |
