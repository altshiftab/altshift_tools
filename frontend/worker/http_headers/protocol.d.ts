// Messages between the /http-headers page and its analysis worker, shared by both builds: the worker
// is transpiled on its own and cannot import, so these are ambient declarations rather than a module.
declare namespace HttpHeadersProtocol {
    // A header block to analyse, as it was pasted.
    interface Request {
        id: number;
        text: string;
    }

    // json is the report the Go analysis returns, which the page reads with parseReport.
    type Message =
        | {kind: "ready"}
        | {kind: "failed"; error: string}
        | {kind: "result"; id: number; json: string}
        | {kind: "error"; id: number; error: string};
}
