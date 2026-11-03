import {test} from "node:test";
import assert from "node:assert/strict";

import {
    countLevels,
    findingDetails,
    findingLocation,
    groupFindings,
    parseReport,
    type Finding,
    type Report,
} from "../src/scripts/lib/http_headers_report.ts";

const cspFinding: Finding = {
    rule_id: "content_security_policy_unsafe_inline",
    level: "error",
    title: "A source of the script-src directive uses an unsafe-inline keyword",
    description: "In the context of script-src, 'unsafe-inline' enables cross-site scripting.",
    header_name: "Content-Security-Policy",
    header_value: "default-src 'self'; script-src 'self' 'unsafe-inline'",
    directive: "script-src",
    directive_value: "'self' 'unsafe-inline'",
    source: "'unsafe-inline'",
};

const hstsFinding: Finding = {
    rule_id: "missing_strict_transport_security",
    level: "error",
    title: "The Strict-Transport-Security header is missing",
    header_name: "Strict-Transport-Security",
};

const referrerFinding: Finding = {
    rule_id: "referrer_policy_unsafe_url",
    level: "warning",
    title: "The Referrer-Policy header is set to \"unsafe-url\"",
    header_name: "Referrer-Policy",
    header_value: "unsafe-url",
};

const obsoleteFinding: Finding = {
    rule_id: "x_frame_options_obsolete",
    level: "none",
    title: "The obsolete X-Frame-Options header is being used",
    header_name: "X-Frame-Options",
    header_value: "SAMEORIGIN",
};

test("parseReport", () => {
    const testCases: {name: string; json: string; expected?: Report; expectedError?: RegExp}[] = [
        {
            name: "a report, as the Go analysis writes it",
            json: JSON.stringify({findings: [cspFinding, obsoleteFinding], field_count: 3, document: true}),
            expected: {findings: [cspFinding, obsoleteFinding], field_count: 3, document: true},
        },
        {
            name: "a failure keeps its kind and message",
            json: '{"findings":[],"field_count":0,"document":false,"error_kind":"parse","error":"The text is not HTTP response headers."}',
            expected: {findings: [], field_count: 0, document: false, error_kind: "parse", error: "The text is not HTTP response headers."},
        },
        {
            name: "a failure without a message is given one",
            json: '{"findings":[],"error_kind":"internal"}',
            expected: {findings: [], field_count: 0, document: false, error_kind: "internal", error: "The headers could not be analysed."},
        },
        {
            name: "fields the page does not know are dropped",
            json: JSON.stringify({findings: [{...hstsFinding, extra: "x"}], field_count: 1, document: true, extra: 1}),
            expected: {findings: [hstsFinding], field_count: 1, document: true},
        },
        {name: "not JSON", json: "not json", expectedError: /JSON/},
        {name: "not an object", json: "[]", expectedError: /not an object/},
        {name: "no findings", json: "{}", expectedError: /no findings/},
        {name: "a finding with an unknown level", json: '{"findings":[{"rule_id":"r","level":"critical","title":"t"}]}', expectedError: /unknown level/},
        {name: "a finding without a rule", json: '{"findings":[{"level":"error","title":"t"}]}', expectedError: /no rule id/},
        {name: "a detail that is not text", json: '{"findings":[{"rule_id":"r","level":"error","title":"t","source":1}]}', expectedError: /source that is not text/},
        {name: "an unknown error kind", json: '{"findings":[],"error_kind":"other"}', expectedError: /unknown error kind/},
    ];

    for (const testCase of testCases) {
        if (testCase.expectedError !== undefined) {
            assert.throws(() => parseReport(testCase.json), testCase.expectedError, testCase.name);
            continue;
        }
        assert.deepEqual(parseReport(testCase.json), testCase.expected, testCase.name);
    }
});

test("groupFindings", () => {
    const testCases: {name: string; findings: Finding[]; expected: {level: string; label: string; rules: string[]}[]}[] = [
        {name: "nothing found", findings: [], expected: []},
        {
            name: "worst first, empty levels left out, the analysis' order kept within a level",
            findings: [obsoleteFinding, referrerFinding, cspFinding, hstsFinding],
            expected: [
                {level: "error", label: "High", rules: [cspFinding.rule_id, hstsFinding.rule_id]},
                {level: "warning", label: "Medium", rules: [referrerFinding.rule_id]},
                {level: "none", label: "Informational", rules: [obsoleteFinding.rule_id]},
            ],
        },
    ];

    for (const testCase of testCases) {
        const got = groupFindings(testCase.findings).map(group => ({
            level: group.level,
            label: group.label,
            rules: group.findings.map(finding => finding.rule_id),
        }));
        assert.deepEqual(got, testCase.expected, testCase.name);
    }
});

test("findingDetails", () => {
    const testCases: {name: string; finding: Finding; expected: [string, string][]}[] = [
        {
            name: "a policy finding names its directive and source rather than the whole policy",
            finding: cspFinding,
            expected: [
                ["Header", "Content-Security-Policy"],
                ["Directive", "script-src"],
                ["Directive value", "'self' 'unsafe-inline'"],
                ["Source", "'unsafe-inline'"],
            ],
        },
        {
            name: "a missing directive names the directive alone",
            finding: {...cspFinding, directive: "base-uri", directive_value: undefined, source: undefined},
            expected: [["Header", "Content-Security-Policy"], ["Directive", "base-uri"]],
        },
        {name: "a header found with a value", finding: referrerFinding, expected: [["Header", "Referrer-Policy"], ["Value", "unsafe-url"]]},
        {name: "a missing header", finding: hstsFinding, expected: [["Header", "Strict-Transport-Security"]]},
        {name: "a finding about no header", finding: {rule_id: "r", level: "note", title: "t"}, expected: []},
    ];

    for (const testCase of testCases) {
        const got = findingDetails(testCase.finding).map(detail => [detail.label, detail.value]);
        assert.deepEqual(got, testCase.expected, testCase.name);
    }
});

test("findingLocation", () => {
    const testCases: {name: string; finding: Finding; expected: string}[] = [
        {name: "a policy source", finding: cspFinding, expected: "Content-Security-Policy › script-src › 'unsafe-inline'"},
        {
            name: "a missing directive",
            finding: {...cspFinding, directive: "base-uri", directive_value: undefined, source: undefined},
            expected: "Content-Security-Policy › base-uri",
        },
        {name: "a header found with a value", finding: referrerFinding, expected: "Referrer-Policy: unsafe-url"},
        {name: "a missing header", finding: hstsFinding, expected: "Strict-Transport-Security"},
        {name: "a value without a header", finding: {rule_id: "r", level: "note", title: "t", header_value: "v"}, expected: "v"},
        {name: "nowhere", finding: {rule_id: "r", level: "note", title: "t"}, expected: ""},
    ];

    for (const testCase of testCases) {
        assert.equal(findingLocation(testCase.finding), testCase.expected, testCase.name);
    }
});

test("countLevels", () => {
    const got = countLevels([obsoleteFinding, cspFinding, hstsFinding, referrerFinding]).map(count => [count.label, count.count]);
    assert.deepEqual(got, [["High", 2], ["Medium", 1], ["Low", 0], ["Informational", 1]], "every level, worst first, zeros kept");
});
