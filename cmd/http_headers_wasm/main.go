//go:build js && wasm

// Command http_headers_wasm exposes the header analysis to JavaScript as globalThis.httpHeaders, with
// analyze(text) returning the report on a pasted header block as JSON. It runs in the /http-headers
// page's worker, so what is pasted is analysed in the browser and never sent anywhere.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"syscall/js"

	"github.com/altshiftab/altshift_tools/pkg/header_report"
)

var (
	errInvalidArgument = errors.New("invalid argument")
	errPanicked        = errors.New("the analysis panicked")
)

// guard turns a panic in a callback into a report: a panic escaping a js.FuncOf callback ends the Go
// program, and every later call from the page would fail.
func guard(callback func(arguments []js.Value) string) js.Func {
	//nolint:nonamedreturns // The deferred recover can only replace the result through its name.
	return js.FuncOf(func(_ js.Value, arguments []js.Value) (result any) {
		defer func() {
			if recovered := recover(); recovered != nil {
				result = errorJson(fmt.Errorf("%w: %v", errPanicked, recovered))
			}
		}()

		return callback(arguments)
	})
}

// errorJson is a report holding nothing but the failure, in the shape the page reads every answer in.
func errorJson(err error) string {
	data, marshalErr := json.Marshal(&header_report.Report{
		Findings:  []*header_report.Finding{},
		ErrorKind: header_report.ErrorKindInternal,
		Error:     err.Error(),
	})
	if marshalErr != nil {
		return `{"findings":[],"error_kind":"internal","error":"The report could not be encoded."}`
	}

	return string(data)
}

// analyze reads the one string argument as a header block and returns its report as JSON.
func analyze(arguments []js.Value) string {
	// Checked here rather than left to syscall/js, whose panic on a value of the wrong type is only
	// caught by the guard.
	if len(arguments) != 1 || arguments[0].Type() != js.TypeString {
		return errorJson(fmt.Errorf("%w: expected (text: string)", errInvalidArgument))
	}

	data, err := json.Marshal(header_report.New(arguments[0].String()))
	if err != nil {
		return errorJson(fmt.Errorf("json marshal: %w", err))
	}

	return string(data)
}

func main() {
	js.Global().Set("httpHeaders", js.ValueOf(map[string]any{
		"analyze": guard(analyze),
	}))

	// Parked, so the functions set above outlive main for as long as the worker does.
	select {}
}
