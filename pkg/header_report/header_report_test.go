package header_report

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	headerRuleId "github.com/altshiftab/altshift_web_security/pkg/http/header_analysis/rule_id"
	headerMappings "github.com/altshiftab/altshift_web_security/pkg/http/header_analysis/rule_id_mappings"
	"github.com/altshiftab/utils_go/pkg/sarif"
)

// exampleBlock is the page's example: a policy that lets inline script and a CDN run, no
// Strict-Transport-Security, a referrer policy that sends the whole URL, and a server that says what
// it runs.
const exampleBlock = "HTTP/2 200\r\n" +
	"content-type: text/html; charset=utf-8\r\n" +
	"content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; object-src 'none'\r\n" +
	"x-frame-options: SAMEORIGIN\r\n" +
	"x-content-type-options: nosniff\r\n" +
	"referrer-policy: unsafe-url\r\n" +
	"server: nginx/1.25.3\r\n" +
	"set-cookie: session=0123456789abcdef; Path=/; HttpOnly\r\n"

func findingByRule(findings []*Finding, ruleId string) *Finding {
	for _, finding := range findings {
		if finding != nil && finding.RuleId == ruleId {
			return finding
		}
	}

	return nil
}

func TestNew(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name               string
		text               string
		expectedErrorKind  string
		expectedError      string
		expectedFieldCount int
		expectedDocument   bool
		// expectedFindings are findings the report must hold, compared whole.
		expectedFindings []*Finding
		// unexpectedRules are rules the report must not hold.
		unexpectedRules []string
	}{
		{
			name:               "a weak policy and no Strict-Transport-Security",
			text:               exampleBlock,
			expectedFieldCount: 7,
			expectedDocument:   true,
			expectedFindings: []*Finding{
				{
					RuleId:         "content_security_policy_unsafe_inline",
					Level:          "error",
					Title:          "A source of the script-src directive uses an unsafe-inline keyword",
					Description:    "In the context of script-src, 'unsafe-inline' enables cross-site scripting (XSS) attacks as overly-permissive means of executing JavaScript are permitted, including inline <script> elements, inline event handlers, and javascript: URLs.",
					HeaderName:     "Content-Security-Policy",
					HeaderValue:    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; object-src 'none'",
					Directive:      "script-src",
					DirectiveValue: "'self' 'unsafe-inline' https://cdn.jsdelivr.net",
					Source:         "'unsafe-inline'",
				},
				{
					RuleId:      "missing_strict_transport_security",
					Level:       "error",
					Title:       "The Strict-Transport-Security header is missing",
					Description: "The Strict-Transport-Security header instructs web browsers to load web pages of the site only over an encrypted channel, via HTTPS. This provides effective protection against man-in-the-middle attacks such as eavesdropping and content alteration.",
					HeaderName:  "Strict-Transport-Security",
				},
				{
					RuleId:      "referrer_policy_unsafe_url",
					Level:       "warning",
					Title:       `The Referrer-Policy header is set to "unsafe-url"`,
					Description: `The "unsafe-url" directive instructs web browsers to send the full URL in its referrer information. This is considered unsafe as the query string could contain sensitive information.`,
					HeaderName:  "Referrer-Policy",
					HeaderValue: "unsafe-url",
				},
				{
					RuleId:      "x_frame_options_obsolete",
					Level:       "none",
					Title:       "The obsolete X-Frame-Options header is being used",
					Description: "The X-Frame-Options header is obsoleted in favor of the frame-ancestors directive of the Content-Security-Policy HTTP header.",
					HeaderName:  "X-Frame-Options",
					HeaderValue: "SAMEORIGIN",
				},
			},
			unexpectedRules: []string{"missing_x_content_type_options", "missing_content_security_policy"},
		},
		{
			// A missing policy is graded none where there is no document to protect, and the report
			// says that is why.
			name:               "a redirect, carrying no document",
			text:               "HTTP/1.1 301 Moved Permanently\nLocation: https://example.com/\n",
			expectedFieldCount: 1,
			expectedDocument:   false,
			expectedFindings: []*Finding{
				{
					RuleId:      "missing_content_security_policy",
					Level:       "none",
					Title:       "The Content-Security-Policy header is missing",
					Description: headerMappings.RuleIdToDescription[headerRuleId.MissingContentSecurityPolicy],
					HeaderName:  "Content-Security-Policy",
				},
			},
		},
		{
			name:              "empty",
			text:              "",
			expectedErrorKind: ErrorKindEmpty,
			expectedError:     "There are no header fields to analyse.",
		},
		{
			name:              "a status line and nothing else",
			text:              "HTTP/1.1 200 OK\r\n\r\n",
			expectedErrorKind: ErrorKindEmpty,
			expectedError:     "There are no header fields to analyse.",
		},
		{
			name:              "prose, which has no colon",
			text:              "this is not a header",
			expectedErrorKind: ErrorKindParse,
			expectedError:     `The text is not HTTP response headers: malformed MIME header: missing colon: "this is not a header".`,
		},
		{
			name:              "prose with a colon in it",
			text:              "Server: nginx\nNote to self: check this\n",
			expectedErrorKind: ErrorKindParse,
			expectedError:     `The text is not HTTP response headers: not a field name: "Note to self".`,
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			report := New(testCase.text)
			if report == nil {
				t.Fatal("New returned nil")
			}

			if report.ErrorKind != testCase.expectedErrorKind || report.Error != testCase.expectedError {
				t.Fatalf(
					"error = (%q, %q), want (%q, %q)",
					report.ErrorKind, report.Error, testCase.expectedErrorKind, testCase.expectedError,
				)
			}

			// The page reads findings as an array whatever happened, so a failed report holds an empty
			// one rather than null.
			if report.Findings == nil {
				t.Error("findings = nil, want an empty slice")
			}

			if report.FieldCount != testCase.expectedFieldCount {
				t.Errorf("field count = %d, want %d", report.FieldCount, testCase.expectedFieldCount)
			}

			if report.Document != testCase.expectedDocument {
				t.Errorf("document = %v, want %v", report.Document, testCase.expectedDocument)
			}

			for _, expected := range testCase.expectedFindings {
				got := findingByRule(report.Findings, expected.RuleId)
				if !reflect.DeepEqual(got, expected) {
					t.Errorf("finding %s =\n%+v\nwant\n%+v", expected.RuleId, got, expected)
				}
			}

			for _, ruleId := range testCase.unexpectedRules {
				if finding := findingByRule(report.Findings, ruleId); finding != nil {
					t.Errorf("unexpected finding %+v", finding)
				}
			}
		})
	}
}

func TestMapRun(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name     string
		run      *sarif.Run
		expected []*Finding
	}{
		{name: "no run", run: nil, expected: []*Finding{}},
		{
			name:     "results without a rule are skipped",
			run:      &sarif.Run{Results: []*sarif.Result{nil, {Level: sarif.LevelError}}},
			expected: []*Finding{},
		},
		{
			// An analyser's own rule with no curated text is explained by its message, less the first
			// sentence, which is already its title.
			name: "a message titles and describes a rule with no curated text",
			run: &sarif.Run{Results: []*sarif.Result{{
				RuleId:  "made_up_rule",
				Level:   sarif.LevelWarning,
				Message: &sarif.Message{Text: "The first sentence. The second sentence."},
			}}},
			expected: []*Finding{{
				RuleId:      "made_up_rule",
				Level:       "warning",
				Title:       "The first sentence",
				Description: "The second sentence.",
			}},
		},
		{
			name: "no level is none, and a property that is not text is absent",
			run: &sarif.Run{Results: []*sarif.Result{{
				RuleId:     "made_up_rule",
				Message:    &sarif.Message{Text: "One sentence only."},
				Properties: sarif.PropertyBag{"headerName": "Server", "headerValue": 42},
			}}},
			expected: []*Finding{{
				RuleId:     "made_up_rule",
				Level:      "none",
				Title:      "One sentence only",
				HeaderName: "Server",
			}},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			if got := MapRun(testCase.run); !reflect.DeepEqual(got, testCase.expected) {
				t.Errorf("MapRun =\n%+v\nwant\n%+v", got, testCase.expected)
			}
		})
	}
}

// TestReportJson pins the names the page reads the report by; frontend lib/http_headers_report.ts
// parses exactly these.
func TestReportJson(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name     string
		report   *Report
		expected string
	}{
		{
			name: "a finding with everything",
			report: &Report{
				Findings: []*Finding{{
					RuleId:         "r",
					Level:          "error",
					Title:          "t",
					Description:    "d",
					HeaderName:     "Content-Security-Policy",
					HeaderValue:    "script-src 'unsafe-inline'",
					Directive:      "script-src",
					DirectiveValue: "'unsafe-inline'",
					Source:         "'unsafe-inline'",
				}},
				FieldCount: 1,
				Document:   true,
			},
			expected: `{"findings":[{"rule_id":"r","level":"error","title":"t","description":"d",` +
				`"header_name":"Content-Security-Policy","header_value":"script-src 'unsafe-inline'",` +
				`"directive":"script-src","directive_value":"'unsafe-inline'","source":"'unsafe-inline'"}],` +
				`"field_count":1,"document":true}`,
		},
		{
			name:     "absent details are left out",
			report:   &Report{Findings: []*Finding{{RuleId: "r", Level: "none", Title: "t"}}},
			expected: `{"findings":[{"rule_id":"r","level":"none","title":"t"}],"field_count":0,"document":false}`,
		},
		{
			name:     "a failure",
			report:   New("garbage"),
			expected: `{"findings":[],"field_count":0,"document":false,"error_kind":"parse","error":"The text is not HTTP response headers: malformed MIME header: missing colon: \"garbage\"."}`,
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			data, err := json.Marshal(testCase.report)
			if err != nil {
				t.Fatalf("json marshal: %v", err)
			}

			if got := string(data); got != testCase.expected {
				t.Errorf("json =\n%s\nwant\n%s", got, testCase.expected)
			}
		})
	}
}

// TestNewKeepsPasteOutOfErrors checks that a failure does not echo what was pasted beyond the line it
// stopped at: the error is shown on the page, and the rest of a paste may be a cookie.
func TestNewKeepsPasteOutOfErrors(t *testing.T) {
	t.Parallel()

	const secret = "session=supersecretvalue"

	report := New("Set-Cookie: " + secret + "\nnot a header\n")
	if report.ErrorKind != ErrorKindParse {
		t.Fatalf("error kind = %q, want %q", report.ErrorKind, ErrorKindParse)
	}

	if strings.Contains(report.Error, secret) {
		t.Errorf("error %q holds the pasted cookie", report.Error)
	}
}
