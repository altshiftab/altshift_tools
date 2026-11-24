package main

import (
	"net/http"
	"strings"
	"testing"

	altshiftMux "github.com/altshiftab/utils_go/pkg/http/mux"
	"github.com/altshiftab/utils_go/pkg/http/mux/types/forwarded_headers"
	"github.com/altshiftab/utils_go/pkg/http/service/service_config"
)

func makeMux(defaultDocumentHeaders map[string]string) *altshiftMux.Mux {
	var mux altshiftMux.Mux
	mux.DefaultDocumentHeaders = defaultDocumentHeaders
	return &mux
}

func TestPatchFingerprintContentSecurityPolicy(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name              string
		mux               *altshiftMux.Mux
		expectedError     bool
		expectedFragments []string
	}{
		{
			name:          "nil mux",
			mux:           nil,
			expectedError: true,
		},
		{
			name:          "nil default document headers",
			mux:           &altshiftMux.Mux{},
			expectedError: true,
		},
		{
			name:          "empty content security policy",
			mux:           makeMux(map[string]string{}),
			expectedError: true,
		},
		{
			name: "worker-src is patched",
			mux: makeMux(map[string]string{
				contentSecurityPolicyHeaderName: "default-src 'self'",
			}),
			expectedFragments: []string{"worker-src", "'self'", "blob:"},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			err := patchFingerprintContentSecurityPolicy(testCase.mux)
			if testCase.expectedError {
				if err == nil {
					t.Fatal("expected an error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			patched := testCase.mux.DefaultDocumentHeaders[contentSecurityPolicyHeaderName]
			for _, fragment := range testCase.expectedFragments {
				if !strings.Contains(patched, fragment) {
					t.Errorf("patched content security policy %q does not contain %q", patched, fragment)
				}
			}
		})
	}
}

// The client of a request through Firebase Hosting, which arrives as `<client>,<Firebase edge>`, is
// the entry before the edge's; a header naming fewer entries names no client.
func TestForwardedForOption(t *testing.T) {
	t.Parallel()

	config := service_config.New(forwardedForOption())
	if config == nil {
		t.Fatal("nil config")
	}

	testCases := []struct {
		name           string
		forwardedFor   string
		expectedClient string
	}{
		{name: "through firebase hosting", forwardedFor: "203.0.113.7,66.249.93.77", expectedClient: "203.0.113.7"},
		{name: "direct call naming a client", forwardedFor: "192.0.2.21,198.51.100.9", expectedClient: "192.0.2.21"},
		{name: "direct call naming none", forwardedFor: "198.51.100.9", expectedClient: ""},
		{name: "no header", expectedClient: ""},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			header := http.Header{}
			if testCase.forwardedFor != "" {
				header.Set("X-Forwarded-For", testCase.forwardedFor)
			}

			client, _ := forwarded_headers.ClientAddress(
				header,
				config.TrustForwardedFor,
				config.TrustClientHeaders,
				config.ForwardedForHops,
				config.TrustedProxies,
			)
			if client != testCase.expectedClient {
				t.Errorf("%s: got %q, want %q", testCase.name, client, testCase.expectedClient)
			}
		})
	}
}
