package main

import (
	"strings"
	"testing"

	altshiftMux "github.com/altshiftab/utils_go/pkg/http/mux"
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
