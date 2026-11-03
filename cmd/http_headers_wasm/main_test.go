//go:build js && wasm

package main

import (
	"encoding/json"
	"strings"
	"syscall/js"
	"testing"

	"github.com/altshiftab/altshift_tools/pkg/header_report"
)

func TestAnalyze(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name              string
		arguments         []js.Value
		expectedErrorKind string
		// expectedErrorPart is text the error must hold, where there is one.
		expectedErrorPart string
		expectedRule      string
	}{
		{
			name:         "a header block",
			arguments:    []js.Value{js.ValueOf("Content-Type: text/html\nReferrer-Policy: unsafe-url\n")},
			expectedRule: "referrer_policy_unsafe_url",
		},
		{
			name:              "text that is not headers",
			arguments:         []js.Value{js.ValueOf("not headers")},
			expectedErrorKind: header_report.ErrorKindParse,
			expectedErrorPart: `"not headers"`,
		},
		{
			name:              "no argument",
			arguments:         nil,
			expectedErrorKind: header_report.ErrorKindInternal,
			expectedErrorPart: "invalid argument",
		},
		{
			name:              "a number",
			arguments:         []js.Value{js.ValueOf(42)},
			expectedErrorKind: header_report.ErrorKindInternal,
			expectedErrorPart: "invalid argument",
		},
		{
			name:              "two strings",
			arguments:         []js.Value{js.ValueOf("a"), js.ValueOf("b")},
			expectedErrorKind: header_report.ErrorKindInternal,
			expectedErrorPart: "invalid argument",
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			var report header_report.Report
			if err := json.Unmarshal([]byte(analyze(testCase.arguments)), &report); err != nil {
				t.Fatalf("json unmarshal: %v", err)
			}

			if report.ErrorKind != testCase.expectedErrorKind {
				t.Fatalf("error kind = %q (%s), want %q", report.ErrorKind, report.Error, testCase.expectedErrorKind)
			}

			if !strings.Contains(report.Error, testCase.expectedErrorPart) {
				t.Errorf("error = %q, want it to hold %q", report.Error, testCase.expectedErrorPart)
			}

			if testCase.expectedRule == "" {
				return
			}

			found := false
			for _, finding := range report.Findings {
				found = found || (finding != nil && finding.RuleId == testCase.expectedRule)
			}
			if !found {
				t.Errorf("findings %+v hold no %s", report.Findings, testCase.expectedRule)
			}
		})
	}
}

func TestGuard(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name     string
		callback func(arguments []js.Value) string
		expected string
	}{
		{name: "the result passes through", callback: func([]js.Value) string { return "ok" }, expected: "ok"},
		{
			name:     "a panic becomes a report",
			callback: func([]js.Value) string { panic("boom") },
			expected: `{"findings":[],"field_count":0,"document":false,"error_kind":"internal","error":"the analysis panicked: boom"}`,
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			function := guard(testCase.callback)
			defer function.Release()

			if got := function.Invoke().String(); got != testCase.expected {
				t.Errorf("got %q, want %q", got, testCase.expected)
			}
		})
	}
}
