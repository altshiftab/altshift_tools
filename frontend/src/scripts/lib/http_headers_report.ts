// The report the Go analysis returns on a pasted header block, and what the /http-headers page makes
// of it. Kept apart from the page so it can be tested without a DOM.

// A finding's level is the analysis' own grading, as SARIF names it; none is what is only worth knowing.
export type Level = "error" | "warning" | "note" | "none";

export type ErrorKind = "empty" | "parse" | "internal";

export interface Finding {
    rule_id: string;
    level: Level;
    title: string;
    description?: string;
    header_name?: string;
    header_value?: string;
    directive?: string;
    directive_value?: string;
    source?: string;
}

export interface Report {
    findings: Finding[];
    field_count: number;
    // Whether the response was taken to carry a document; without one, the headers that protect a
    // document are graded none.
    document: boolean;
    error_kind?: ErrorKind;
    error?: string;
}

export const levels: readonly Level[] = ["error", "warning", "note", "none"];

// The library grades by severity and maps high, medium, low and info onto the SARIF levels; the page
// says the severity, which is what a reader is looking for.
export const levelLabels: Readonly<Record<Level, string>> = {
    error: "High",
    warning: "Medium",
    note: "Low",
    none: "Informational",
};

const errorKinds: readonly ErrorKind[] = ["empty", "parse", "internal"];

const optionalFindingFields = [
    "description",
    "header_name",
    "header_value",
    "directive",
    "directive_value",
    "source",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFinding(value: unknown, index: number): Finding {
    if (!isRecord(value)) {
        throw new TypeError(`finding ${index} is not an object`);
    }

    const {rule_id: ruleId, level, title} = value;
    if (typeof ruleId !== "string" || ruleId === "") {
        throw new TypeError(`finding ${index} has no rule id`);
    }
    if (typeof level !== "string" || !levels.includes(level as Level)) {
        throw new TypeError(`finding ${index} has an unknown level: ${String(level)}`);
    }
    if (typeof title !== "string") {
        throw new TypeError(`finding ${index} has no title`);
    }

    const finding: Finding = {rule_id: ruleId, level: level as Level, title};
    for (const field of optionalFindingFields) {
        const fieldValue = value[field];
        if (fieldValue === undefined) {
            continue;
        }
        if (typeof fieldValue !== "string") {
            throw new TypeError(`finding ${index} has a ${field} that is not text`);
        }
        finding[field] = fieldValue;
    }

    return finding;
}

// parseReport reads the analysis' JSON, refusing anything that is not the shape the page renders
// rather than rendering half of it.
export function parseReport(json: string): Report {
    const value: unknown = JSON.parse(json);
    if (!isRecord(value)) {
        throw new TypeError("the report is not an object");
    }

    const {findings, field_count: fieldCount, document, error_kind: errorKind, error} = value;
    if (!Array.isArray(findings)) {
        throw new TypeError("the report has no findings");
    }

    const report: Report = {
        findings: findings.map(parseFinding),
        field_count: typeof fieldCount === "number" ? fieldCount : 0,
        document: document === true,
    };

    if (errorKind !== undefined) {
        if (typeof errorKind !== "string" || !errorKinds.includes(errorKind as ErrorKind)) {
            throw new TypeError(`the report has an unknown error kind: ${String(errorKind)}`);
        }
        report.error_kind = errorKind as ErrorKind;
        report.error = typeof error === "string" && error !== "" ? error : "The headers could not be analysed.";
    }

    return report;
}

export interface FindingGroup {
    level: Level;
    label: string;
    findings: Finding[];
}

// groupFindings sorts the findings into one group per level, worst first, leaving out the levels
// nothing was found at. Within a group the analysis' own order is kept, which is by header.
export function groupFindings(findings: readonly Finding[]): FindingGroup[] {
    return levels
        .map(level => ({level, label: levelLabels[level], findings: findings.filter(finding => finding.level === level)}))
        .filter(group => group.findings.length > 0);
}

export interface FindingDetail {
    label: string;
    value: string;
}

// findingDetails says where a finding was found. A Content-Security-Policy finding is about one
// directive of a policy that can run to hundreds of characters, so it names the directive, what the
// policy gives it and the source at fault, rather than the policy whole; any other finding names the
// header and the value it was found in.
export function findingDetails(finding: Finding): FindingDetail[] {
    const details: FindingDetail[] = [];

    if (finding.header_name) {
        details.push({label: "Header", value: finding.header_name});
    }

    if (finding.directive) {
        details.push({label: "Directive", value: finding.directive});
        if (finding.directive_value) {
            details.push({label: "Directive value", value: finding.directive_value});
        }
        if (finding.source) {
            details.push({label: "Source", value: finding.source});
        }
        return details;
    }

    if (finding.header_value) {
        details.push({label: "Value", value: finding.header_value});
    }

    return details;
}

// findingLocation is where a finding is, on one line under its title: the header, and for a policy
// the directive and the source at fault, or else the value the header was found with.
export function findingLocation(finding: Finding): string {
    const parts: string[] = [];
    if (finding.header_name) {
        parts.push(finding.header_name);
    }

    if (finding.directive) {
        parts.push(finding.directive);
        if (finding.source) {
            parts.push(finding.source);
        }
        return parts.join(" › ");
    }

    const location = parts.join(" › ");
    if (finding.header_value) {
        return location === "" ? finding.header_value : `${location}: ${finding.header_value}`;
    }

    return location;
}

export interface LevelCount {
    level: Level;
    label: string;
    count: number;
}

// countLevels is how many findings there are at each level, every level included, worst first.
export function countLevels(findings: readonly Finding[]): LevelCount[] {
    return levels.map(level => ({
        level,
        label: levelLabels[level],
        count: findings.filter(finding => finding.level === level).length,
    }));
}
