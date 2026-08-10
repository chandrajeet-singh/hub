import { z } from 'zod';
import {
    ConnectorConfigField,
    FalconFieldValidation,
    FieldValidation,
    FormatName,
    LegacyFieldValidation,
} from '../types';
import { isSecretPlaceholder } from './secretPlaceholder';

// Local copy of the canonical `FORMAT_PATTERNS` registry from `@stackone/core`
// (connect repo, `packages/core/src/connector/formatPatterns.ts`) — the hub
// deliberately carries no @stackone package dependencies for this feature. Keep in
// sync when a format changes; `scripts/check-format-vectors.ts` (run via `npm test`)
// asserts this copy against the canonical accept/reject vectors so a drifted copy
// fails CI. Exported for that script.
export const FORMAT_PATTERNS: Record<FormatName, RegExp> = {
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    url: /^https?:\/\/[^\s/?#]+\S*$/,
    uri: /^[a-zA-Z][a-zA-Z0-9+.-]*:.+$/,
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    date: /^\d{4}-\d{2}-\d{2}$/,
    datetime: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}(?::?\d{2})?)?$/,
};

interface ValidationRule {
    pattern: RegExp;
    errorMessage: string;
}

function isLegacyValidation(validation: FieldValidation): validation is LegacyFieldValidation {
    return validation.type !== undefined;
}

// Compile a pattern, degrading to null (no rule) on an invalid regex rather than throwing.
// `createFormSchema` runs inside a render `useMemo`, so an uncompilable pattern would
// otherwise throw during render and trip the error boundary — replacing the whole hub and
// making the connector unlinkable. connect-sdk's build-time compile+ReDoS lint covers the
// `connectors` repo, but not the legacy TS path or whatever a direct-API surface returns
// (D1), nor the ReDoS blind spot (overlapping alternation) — so guard here too.
function compileRegex(source: string): RegExp | null {
    try {
        return new RegExp(source);
    } catch {
        return null;
    }
}

// V2/legacy TS connectors — behaviour preserved as-is, delete wholesale when V2 retires
function resolveLegacyRule(validation: LegacyFieldValidation): ValidationRule | null {
    if (validation.type === 'html-pattern') {
        const pattern = compileRegex(validation.pattern);
        if (!pattern) return null;
        return {
            pattern,
            errorMessage:
                validation.error || `Please match the required format: ${validation.pattern}`,
        };
    }

    if (validation.type === 'domain') {
        const pattern = compileRegex(`.*${validation.pattern}\\.com.*`);
        if (!pattern) return null;
        return {
            pattern,
            errorMessage:
                validation.error || `Please enter a valid ${validation.pattern}.com domain`,
        };
    }

    return null;
}

function resolveFalconRule(
    validation: FalconFieldValidation,
    label: string,
): ValidationRule | null {
    if (validation.format) {
        const pattern = FORMAT_PATTERNS[validation.format];
        if (!pattern) {
            // Unknown format: connect-sdk derives its `format` enum from the canonical
            // registry keys, so a format it accepts is missing here — this copy has drifted
            // from `@stackone/core`. Fail open (failing closed would lock customers out on a
            // hub-version skew) but loudly, since the field then renders unvalidated on the
            // only enforcement layer. `scripts/check-format-vectors.ts` should catch this in
            // CI; this warns at runtime if a drift ever reaches a customer.
            console.warn(
                `[stackone-hub] no pattern for format "${validation.format}" — field validation skipped; hub FORMAT_PATTERNS has drifted from @stackone/core`,
            );
            return null;
        }
        return {
            pattern,
            errorMessage: validation.errorMessage || `Must be a valid ${validation.format}`,
        };
    }

    if (validation.pattern) {
        const pattern = compileRegex(validation.pattern);
        if (!pattern) return null;
        return {
            pattern,
            errorMessage: validation.errorMessage || `${label} format is invalid`,
        };
    }

    return null;
}

function resolveValidationRule(field: ConnectorConfigField): ValidationRule | null {
    if (!field.validation) return null;

    return isLegacyValidation(field.validation)
        ? resolveLegacyRule(field.validation)
        : resolveFalconRule(field.validation, field.label);
}

export type RecordValidationFailure = (
    field: ConnectorConfigField,
    validation: FieldValidation,
) => void;

// RFC step 9 (client half): the hub is a customer-embedded package with no analytics
// dependency, so validation failures are surfaced as a DOM CustomEvent — count-only
// (connector key + field key + rule kind, never the value; values may be
// credentials). Hosts or StackOne scripts can listen via
// window.addEventListener('stackone-hub:field-validation-failed', ...).
//
// Lifetime: the recorder must be owned by the rendering component for the life of
// the form session (useMemo keyed on the connector) and passed into
// createFormSchema — NOT created per schema build. The schema does not survive a
// keystroke (keystroke → onChange(formData) → new `fields` identity in
// useIntegrationPicker → schema useMemo rebuilds), so a recorder owned by the
// schema would reset its per-field dedupe on every rebuild and dispatch one event
// per keystroke instead of at most once per field. No-op outside the browser
// (e.g. the npm-test vector check).
export function createValidationFailureRecorder(connector?: string): RecordValidationFailure {
    const firedFields = new Set<string>();

    return (field, validation) => {
        if (typeof window === 'undefined' || firedFields.has(field.key)) return;
        firedFields.add(field.key);

        const format = isLegacyValidation(validation) ? undefined : validation.format;
        window.dispatchEvent(
            new CustomEvent('stackone-hub:field-validation-failed', {
                detail: {
                    ...(connector ? { connector } : {}),
                    field: field.key,
                    ruleKind: isLegacyValidation(validation)
                        ? 'legacy'
                        : format
                          ? 'format'
                          : 'pattern',
                    ...(format ? { format } : {}),
                },
            }),
        );
    };
}

function createFieldSchema(
    field: ConnectorConfigField,
    recordFailure: RecordValidationFailure,
): z.ZodTypeAny {
    let schema: z.ZodString = z.string();

    if (field.required) {
        schema = schema.min(1, `${field.label} is required`);
    }

    if (field.type === 'number') {
        if (field.required) {
            schema = schema.regex(/^\d+$/, 'Must be a valid number');
        } else {
            return z
                .string()
                .refine((val) => val === '' || /^\d+$/.test(val), 'Must be a valid number');
        }
    }

    const validation = field.validation;
    const rule = resolveValidationRule(field);
    if (rule && validation) {
        const testWithMetric = (val: string) => {
            // A saved secret is pre-filled as the redacted sentinel (`__secretvalue:**…`),
            // not the real value the customer typed. RHF validates `defaultValues` eagerly,
            // so without this guard the sentinel would fail the rule before the user touches
            // anything — blocking reconnect (gating the Connect button) and emitting a
            // failure event for an untouched field. Treat it as valid.
            if (isSecretPlaceholder(val)) return true;
            // The `&& val` guard is load-bearing: zod 4 accumulates all checks (it does not
            // short-circuit on `.min(1)`), so this predicate runs on empty values too. Empty
            // is a "required" failure, not a format failure — without `&& val` every
            // untouched required field would emit a spurious event.
            const ok = rule.pattern.test(val);
            if (!ok && val) {
                recordFailure(field, validation);
            }
            return ok;
        };
        if (field.required) {
            return schema.refine((val) => testWithMetric(val), rule.errorMessage);
        }
        return z.string().refine((val) => val === '' || testWithMetric(val), rule.errorMessage);
    }

    if (!field.required) {
        return z.union([z.string().length(0), schema]);
    }

    return schema;
}

// `recordFailure` is owned by the caller and must outlive this schema (see
// createValidationFailureRecorder's lifetime note) — schemas are rebuilt per
// keystroke, so a recorder created here would count keystrokes, not fields.
// Defaults to a no-op for callers without telemetry (tests, the vector check).
const noopRecorder: RecordValidationFailure = () => undefined;

export function createFormSchema(
    fields: ConnectorConfigField[],
    recordFailure: RecordValidationFailure = noopRecorder,
) {
    const schemaShape: Record<string, z.ZodTypeAny> = {};

    for (const field of fields) {
        schemaShape[field.key] = createFieldSchema(field, recordFailure);
    }

    return z.object(schemaShape);
}
