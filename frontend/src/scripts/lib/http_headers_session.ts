import type {Analyser} from "./http_headers_client.ts";
import {groupFindings, parseReport, type FindingGroup, type Report} from "./http_headers_report.ts";

// What the /http-headers page shows below the text area.
export type ViewState =
    // Nothing has been pasted.
    | {kind: "idle"}
    // Something has, and the analyser is still being loaded to read it.
    | {kind: "loading"}
    // What was pasted is not header fields; message says why.
    | {kind: "invalid"; message: string}
    // The analysis could not be run at all; message says why.
    | {kind: "failed"; message: string}
    | {kind: "report"; report: Report; groups: FindingGroup[]};

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// viewOfReport is what a report from the analysis shows as.
export function viewOfReport(report: Report): ViewState {
    switch (report.error_kind) {
        // A status line on its own is what there is partway through typing one; nothing is wrong yet.
        case "empty":
            return {kind: "idle"};
        case "parse":
            return {kind: "invalid", message: report.error ?? "The text is not HTTP response headers."};
        case "internal":
            return {kind: "failed", message: report.error ?? "The headers could not be analysed."};
    }

    return {kind: "report", report, groups: groupFindings(report.findings)};
}

// HttpHeadersSession turns what is in the text area into what the page shows. Each edit is analysed
// as it is made, and an answer that arrives after a later edit was made is dropped, so the page never
// shows the findings for text that is no longer there.
export class HttpHeadersSession {
    readonly #startAnalyser: () => Promise<Analyser>;
    readonly #onChange: (state: ViewState) => void;
    #analyser: Promise<Analyser> | undefined;
    #started = false;
    #generation = 0;
    #closed = false;

    constructor(startAnalyser: () => Promise<Analyser>, onChange: (state: ViewState) => void) {
        this.#startAnalyser = startAnalyser;
        this.#onChange = onChange;
    }

    // start loads the analyser ahead of the first paste, so that it is ready by then. A failure is
    // left for the first update to report, there being nothing yet to report it against.
    start(): Promise<Analyser> {
        if (this.#analyser === undefined) {
            try {
                this.#analyser = this.#startAnalyser();
            } catch (error) {
                this.#analyser = Promise.reject(error);
            }
            // A failure stays: the analyser is not started again for every edit made after it.
            this.#analyser.then(() => void (this.#started = true), () => undefined);
        }

        return this.#analyser;
    }

    async update(text: string): Promise<void> {
        if (this.#closed) {
            return;
        }

        const generation = ++this.#generation;
        if (text.trim() === "") {
            this.#onChange({kind: "idle"});
            return;
        }

        if (!this.#started) {
            this.#onChange({kind: "loading"});
        }

        let state: ViewState;
        try {
            const analyser = await this.start();
            state = viewOfReport(parseReport(await analyser.analyze(text)));
        } catch (error) {
            state = {kind: "failed", message: errorMessage(error)};
        }

        if (generation === this.#generation && !this.#closed) {
            this.#onChange(state);
        }
    }

    // close stops the analyser and anything still to be shown, for a page that is going away.
    close(): void {
        this.#closed = true;
        this.#analyser?.then(analyser => analyser.terminate(), () => undefined);
    }
}
