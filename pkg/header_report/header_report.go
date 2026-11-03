// Package header_report is what the /http-headers page shows of a pasted header block: the findings
// altshift_web_security raises against it, flattened into what a page can render.
//
// It runs in the browser, compiled to WebAssembly, so the headers a person pastes -- cookies, session
// ids, internal host names -- are analysed where they are and sent nowhere.
package header_report

import (
	"errors"
	"fmt"
	"net/textproto"
	"strings"

	headerAnalysis "github.com/altshiftab/altshift_web_security/pkg/http/header_analysis/analysis"
	cspAnalysis "github.com/altshiftab/altshift_web_security/pkg/http/header_analysis/analysis/content_security_policy"
	"github.com/altshiftab/altshift_web_security/pkg/http/header_analysis/header_block"
	headerMappings "github.com/altshiftab/altshift_web_security/pkg/http/header_analysis/rule_id_mappings"
	altshiftErrors "github.com/altshiftab/utils_go/pkg/errors"
	"github.com/altshiftab/utils_go/pkg/errors/types/empty_error"
	"github.com/altshiftab/utils_go/pkg/sarif"
)

// The ways a report can fail, as the page tells them apart.
const (
	// ErrorKindEmpty is a block with no fields in it, which the page shows as nothing to analyse rather
	// than as a mistake.
	ErrorKindEmpty = "empty"
	// ErrorKindParse is text that is not header fields.
	ErrorKindParse = "parse"
	// ErrorKindInternal is the analysis failing on fields it was able to read.
	ErrorKindInternal = "internal"
)

// Finding is one thing wrong with the headers.
type Finding struct {
	// RuleId identifies the finding, and is stable where the title is prose.
	RuleId string `json:"rule_id"`
	// Level is the analysis' grading: error, warning, note, or none for what is only worth knowing.
	Level       string `json:"level"`
	Title       string `json:"title"`
	Description string `json:"description,omitzero"`
	// HeaderName is the header the finding was raised on, where it was raised on one.
	HeaderName string `json:"header_name,omitzero"`
	// HeaderValue is that header as it was pasted, absent where the header is missing.
	HeaderValue string `json:"header_value,omitzero"`
	// Directive is the policy directive a Content-Security-Policy finding is about, which for a
	// missing directive is the one that is missing.
	Directive string `json:"directive,omitzero"`
	// DirectiveValue is that directive as the policy states it.
	DirectiveValue string `json:"directive_value,omitzero"`
	// Source is the one source of the directive that caused the finding, where one did.
	Source string `json:"source,omitzero"`
}

// Report is the analysis of one header block, or why there is none.
type Report struct {
	Findings []*Finding `json:"findings"`
	// FieldCount is the number of header field lines read, a repeated field counting each time, so
	// the page can say what it saw.
	FieldCount int `json:"field_count"`
	// Document says whether the response was taken to carry a document. Without a Content-Type,
	// Content-Length or Transfer-Encoding it is not, and the headers that protect a document are
	// graded none.
	Document bool `json:"document"`
	// ErrorKind and Error say why there are no findings, when that is because of a failure.
	ErrorKind string `json:"error_kind,omitzero"`
	Error     string `json:"error,omitzero"`
}

// New parses a pasted header block and reports what is wrong with it.
//
// It does not return an error: a failure is part of the report, because the page shows it in place
// of the findings and the bridge to JavaScript has nowhere else to put one.
func New(text string) *Report {
	header, err := header_block.Parse(text)
	if err != nil {
		if _, ok := errors.AsType[*empty_error.Error](err); ok {
			return &Report{Findings: []*Finding{}, ErrorKind: ErrorKindEmpty, Error: "There are no header fields to analyse."}
		}

		return &Report{Findings: []*Finding{}, ErrorKind: ErrorKindParse, Error: parseErrorMessage(err)}
	}

	run, err := headerAnalysis.AnalyzeHeaders(header)
	if err != nil {
		return &Report{
			Findings:  []*Finding{},
			ErrorKind: ErrorKindInternal,
			Error:     fmt.Sprintf("The headers could not be analysed: %v", err),
		}
	}

	fieldCount := 0
	for _, values := range header {
		fieldCount += len(values)
	}

	return &Report{
		Findings:   MapRun(run),
		FieldCount: fieldCount,
		Document:   headerAnalysis.ResponseHasBody(header),
	}
}

// parseErrorMessage says what about the text could not be read. The reader's own complaint quotes
// the line it stopped at, which is what a person needs to find it; the wrapping around it names
// functions, which they do not.
func parseErrorMessage(err error) string {
	detail := err.Error()
	if protocolError, ok := errors.AsType[textproto.ProtocolError](err); ok {
		detail = string(protocolError)
	}

	detail = strings.TrimPrefix(detail, altshiftErrors.ErrParseError.Error()+": ")

	return fmt.Sprintf("The text is not HTTP response headers: %s.", detail)
}

// MapRun flattens an analysis into findings, in the order the analysis raised them.
//
// Unlike signals_monitor, which stores a list of problems, a result graded none is kept: on a page a
// person reads to clean up their headers, an obsolete X-XSS-Protection is worth a line, and the page
// shows such results apart from the problems.
func MapRun(run *sarif.Run) []*Finding {
	findings := make([]*Finding, 0)
	if run == nil {
		return findings
	}

	for _, result := range run.Results {
		if result == nil || result.RuleId == "" {
			continue
		}

		level := string(result.Level)
		if level == "" {
			level = string(sarif.LevelNone)
		}

		title := headerAnalysis.Title(result)

		findings = append(findings, &Finding{
			RuleId:         result.RuleId,
			Level:          level,
			Title:          title,
			Description:    description(result, title),
			HeaderName:     property(result, "headerName"),
			HeaderValue:    property(result, "headerValue"),
			Directive:      property(result, cspAnalysis.PropertyDirective),
			DirectiveValue: property(result, cspAnalysis.PropertyDirectiveValue),
			Source:         property(result, cspAnalysis.PropertySource),
		})
	}

	return findings
}

// property reads what the analysis recorded about where a finding came from. The properties are a
// bag of anything, so a value that is not text is treated as absent.
func property(result *sarif.Result, name string) string {
	value, _ := result.Properties[name].(string)

	return value
}

// description is the explanation under the title: the curated description where the rule has one,
// and otherwise the analyser's own message, which is where a rule whose wording depends on what was
// found says what it found. Such a rule is titled by the message's first sentence, which is not said
// twice.
func description(result *sarif.Result, title string) string {
	if text := headerMappings.RuleIdToDescription[result.RuleId]; text != "" &&
		text != string(headerMappings.SeverityDynamic) {
		return text
	}

	if result.Message == nil {
		return ""
	}

	text := strings.TrimSpace(result.Message.Text)
	if rest, found := strings.CutPrefix(text, title+"."); found && title != "" {
		return strings.TrimSpace(rest)
	}

	return text
}
