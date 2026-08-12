/**
 * Conformance gate for the hub's local FORMAT_PATTERNS copy, run via `npm test`.
 * Three layers, each catching a different drift mode — be precise about what each
 * can and cannot catch:
 *
 *  1. Vectors (offline): every pattern passes the pinned accept/reject vectors, and
 *     every registry key has vectors. Catches semantic drift the vectors encode —
 *     but NOT a regression that keeps the accepted language identical (the round-1
 *     quadratic `url` form passed every vector).
 *  2. Pinned canonical sources (offline): every pattern's source+flags must equal
 *     the canonical regex text pinned below. Catches language-identical rewrites
 *     drifting from canonical — but the pin itself is a hub-local snapshot; bump it
 *     together with the registry copy when connect's registry changes.
 *  3. Live canonical comparison (network): fetches connect main's actual
 *     `formatPatterns.ts` and compares key sets and sources. The only layer that
 *     catches an upstream format ADDED after this snapshot. Enforcing when the file
 *     is reachable; warns loudly (never silently passes) when it is not — e.g.
 *     before connect#1304 publishes the canonical file to main.
 *
 * Canonical sources: connect repo, `packages/core/src/connector/formatPatterns.ts`
 * and `packages/core/src/connector/specs/formatPatterns.vectors.ts`.
 */
import { FORMAT_PATTERNS } from '../src/modules/integration-picker/utils/zodSchema';

// Layer 2 pin: the canonical regex text, verbatim (source without delimiters, then
// flags). Snapshot of connect#1304 head — bump alongside the registry copy.
const CANONICAL_PATTERN_SOURCES: Record<string, { source: string; flags: string }> = {
    email: { source: '^[^\\s@]+@(?=[^\\s@]+\\.[^\\s@])[^\\s@]+$', flags: '' },
    url: { source: '^https?:\\/\\/[^\\s/?#]+(?:[/?#]\\S*)?$', flags: '' },
    uri: { source: '^[a-zA-Z][a-zA-Z0-9+.-]*:\\S+$', flags: '' },
    uuid: {
        source: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        flags: 'i',
    },
    date: { source: '^\\d{4}-\\d{2}-\\d{2}$', flags: '' },
    datetime: {
        source: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:[Zz]|[+-]\\d{2}(?::?\\d{2})?)?$',
        flags: '',
    },
};

const CANONICAL_REGISTRY_URL =
    'https://raw.githubusercontent.com/StackOneHQ/connect/main/packages/core/src/connector/formatPatterns.ts';

const FORMAT_PATTERN_TEST_VECTORS: Record<string, { accepts: string[]; rejects: string[] }> = {
    email: {
        accepts: ['john@example.com', 'a.b+tag@sub.domain.co'],
        rejects: ['not-an-email', 'a b@example.com', '@example.com', 'john@'],
    },
    url: {
        accepts: [
            'https://api.example.com',
            'http://x.io/path?q=1',
            'http://localhost:3000',
            'https://1.2.3.4/p?q=1',
            'https://x.io/a?b=c#d',
        ],
        rejects: [
            'example.com',
            'ftp://host',
            '',
            'https://api.example.com extra text',
            'https://foo bar/baz',
            'https://',
            'https://?q=1',
            'https:///path',
            'https://#frag',
            'https://a b',
        ],
    },
    uri: {
        accepts: ['https://api.example.com', 'mailto:x@y.z', 'urn:isbn:0451450523'],
        rejects: [
            'no-scheme-here',
            '://missing',
            '',
            'urn:isbn:0451450523 and some trailing prose',
            'mailto:a@b.c <-- paste error',
        ],
    },
    uuid: {
        accepts: ['123e4567-e89b-12d3-a456-426614174000', '123E4567-E89B-12D3-A456-426614174000'],
        rejects: ['123e4567', 'zzze4567-e89b-12d3-a456-426614174000', ''],
    },
    date: {
        accepts: ['2026-07-06', '1999-12-31'],
        rejects: ['06-07-2026', '2026/07/06', '2026-7-6', ''],
    },
    datetime: {
        accepts: [
            '2026-07-06T10:30:00',
            '2026-07-06T10:30:00Z',
            '2026-07-06T10:30:00+01:00',
            '2026-07-06T10:30:00.123Z',
            '2026-07-06T10:30:00z',
            '2026-07-06T10:30:00+0100',
            '2026-07-06T10:30:00+01',
        ],
        rejects: [
            '2026-07-06',
            '10:30:00',
            '',
            '2026-07-06T10:30:00banana',
            '2026-07-06T10:30:00Zzz',
        ],
    },
};

let failures = 0;

// Layer 1: pattern <-> vector conformance.
for (const [format, vectors] of Object.entries(FORMAT_PATTERN_TEST_VECTORS)) {
    const pattern = FORMAT_PATTERNS[format as keyof typeof FORMAT_PATTERNS];
    if (!pattern) {
        failures++;
        console.error(`FAIL: registry is missing format "${format}"`);
        continue;
    }
    for (const value of vectors.accepts) {
        if (!pattern.test(value)) {
            failures++;
            console.error(`FAIL: ${format} should accept "${value}"`);
        }
    }
    for (const value of vectors.rejects) {
        if (pattern.test(value)) {
            failures++;
            console.error(`FAIL: ${format} should reject "${value}"`);
        }
    }
}

// Reverse coverage: a format added to the registry (mirroring a new core format) with no
// vectors here would otherwise pass silently — the exact drift D3 exists to catch (a field
// with an unrecognised format renders unvalidated). Fail if any registry key lacks vectors.
for (const format of Object.keys(FORMAT_PATTERNS)) {
    if (!FORMAT_PATTERN_TEST_VECTORS[format]) {
        failures++;
        console.error(`FAIL: no vectors for registry format "${format}"`);
    }
}

// Layer 2: pinned canonical sources — catches a rewrite that keeps the accepted
// language identical (invisible to vectors) but drifts from the canonical regex text.
for (const [format, canonical] of Object.entries(CANONICAL_PATTERN_SOURCES)) {
    const pattern = FORMAT_PATTERNS[format as keyof typeof FORMAT_PATTERNS];
    if (!pattern) {
        failures++;
        console.error(`FAIL: registry is missing pinned canonical format "${format}"`);
        continue;
    }
    if (pattern.source !== canonical.source || pattern.flags !== canonical.flags) {
        failures++;
        console.error(
            `FAIL: ${format} source drifted from the pinned canonical\n  local:     /${pattern.source}/${pattern.flags}\n  canonical: /${canonical.source}/${canonical.flags}`,
        );
    }
}
for (const format of Object.keys(FORMAT_PATTERNS)) {
    if (!CANONICAL_PATTERN_SOURCES[format]) {
        failures++;
        console.error(`FAIL: no pinned canonical source for registry format "${format}"`);
    }
}

// Layer 3: live comparison against connect main's actual registry — the only layer
// that can catch a format added upstream after the layer-2 snapshot. Enforcing when
// reachable; loud (never silent) when not.
const compareAgainstLiveCanonical = async (): Promise<void> => {
    let body: string;
    try {
        const response = await fetch(CANONICAL_REGISTRY_URL);
        if (response.status === 404) {
            console.warn(
                'WARN: canonical formatPatterns.ts not found on connect main (404) — the file ships with connect#1304; the live-canonical layer is inactive until it merges',
            );
            return;
        }
        if (!response.ok) {
            console.warn(
                `WARN: could not fetch canonical registry (HTTP ${response.status}) — live-canonical layer skipped this run`,
            );
            return;
        }
        body = await response.text();
    } catch (error) {
        console.warn(
            `WARN: could not fetch canonical registry (${error instanceof Error ? error.message : String(error)}) — live-canonical layer skipped this run`,
        );
        return;
    }

    // Extract `key: /source/flags,` entries from the canonical registry literal. A
    // regex literal's source may contain unescaped `/` inside a character class
    // (`[^\s/?#]`), so classes are matched as their own alternative.
    const entries = new Map<string, { source: string; flags: string }>();
    const entryPattern = /^\s{4}(\w+): \/((?:[^/\\[\n]|\\.|\[(?:[^\]\\]|\\.)*\])+)\/([a-z]*),$/gm;
    for (const match of body.matchAll(entryPattern)) {
        entries.set(match[1], { source: match[2], flags: match[3] });
    }
    if (entries.size === 0) {
        console.warn(
            'WARN: fetched canonical registry but parsed no pattern entries — live-canonical layer needs its parser updated',
        );
        return;
    }

    for (const [format, canonical] of entries) {
        const pattern = FORMAT_PATTERNS[format as keyof typeof FORMAT_PATTERNS];
        if (!pattern) {
            failures++;
            console.error(
                `FAIL: connect main's registry has format "${format}" — missing from the hub copy (add the pattern, vectors and pinned source)`,
            );
            continue;
        }
        if (pattern.source !== canonical.source || pattern.flags !== canonical.flags) {
            failures++;
            console.error(
                `FAIL: ${format} drifted from connect main\n  local:     /${pattern.source}/${pattern.flags}\n  canonical: /${canonical.source}/${canonical.flags}`,
            );
        }
    }
    console.log(`Live canonical comparison ran against ${entries.size} upstream formats`);
};

compareAgainstLiveCanonical().then(() => {
    if (failures > 0) {
        console.error(`${failures} format conformance failure(s)`);
        process.exit(1);
    }
    console.log('All format vectors and canonical-source checks pass');
});
