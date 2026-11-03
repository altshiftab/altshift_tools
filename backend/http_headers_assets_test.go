package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	altshiftMux "github.com/altshiftab/utils_go/pkg/http/mux"
	muxTesting "github.com/altshiftab/utils_go/pkg/http/mux/testing"
)

// fakeHttpHeadersAssets is a build of the assets whose every file says which it is, so a response can
// be checked for having served the right one.
func fakeHttpHeadersAssets(omit ...string) fstest.MapFS {
	assets := fstest.MapFS{}
	for _, asset := range httpHeadersAssetList {
		for _, name := range []string{asset.name, asset.name + ".br", asset.name + ".gz"} {
			assets[httpHeadersAssetsDirectory+"/"+name] = &fstest.MapFile{Data: []byte("contents of " + name)}
		}
	}

	for _, name := range omit {
		delete(assets, httpHeadersAssetsDirectory+"/"+name)
	}

	return assets
}

func TestHttpHeadersAssetEndpoints(t *testing.T) {
	t.Parallel()

	endpoints, err := newHttpHeadersAssetEndpoints(fakeHttpHeadersAssets())
	if err != nil {
		t.Fatalf("new http headers asset endpoints: %v", err)
	}

	server := httptest.NewServer(altshiftMux.New(endpoints...))
	t.Cleanup(server.Close)

	workerHeaders := [][2]string{
		{"Content-Type", javascriptContentType},
		{"Content-Security-Policy", httpHeadersWorkerContentSecurityPolicy},
		{"Cross-Origin-Embedder-Policy", "require-corp"},
		{"Cache-Control", "no-cache"},
	}

	testCases := []struct {
		name            string
		path            string
		acceptEncoding  string
		expectedHeaders [][2]string
		expectedBody    string
	}{
		{
			name:            "worker",
			path:            "/analysis/http_headers/worker.js",
			acceptEncoding:  "identity",
			expectedHeaders: workerHeaders,
			expectedBody:    "contents of worker.js",
		},
		{
			// The policy that lets the worker compile the module must reach the encoding a browser
			// actually receives.
			name:            "worker, brotli",
			path:            "/analysis/http_headers/worker.js",
			acceptEncoding:  "br",
			expectedHeaders: append([][2]string{{"Content-Encoding", "br"}}, workerHeaders...),
			expectedBody:    "contents of worker.js.br",
		},
		{
			name:            "runtime glue, gzip",
			path:            "/analysis/http_headers/wasm_exec.js",
			acceptEncoding:  "gzip",
			expectedHeaders: [][2]string{{"Content-Type", javascriptContentType}, {"Content-Encoding", "gzip"}},
			expectedBody:    "contents of wasm_exec.js.gz",
		},
		{
			// The type is what lets the worker compile the module as it streams in.
			name:            "module, brotli",
			path:            "/analysis/http_headers/http_headers.wasm",
			acceptEncoding:  "br",
			expectedHeaders: [][2]string{{"Content-Type", "application/wasm"}, {"Content-Encoding", "br"}},
			expectedBody:    "contents of http_headers.wasm.br",
		},
		{
			name:            "module, identity",
			path:            "/analysis/http_headers/http_headers.wasm",
			acceptEncoding:  "identity",
			expectedHeaders: [][2]string{{"Content-Type", "application/wasm"}},
			expectedBody:    "contents of http_headers.wasm",
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			muxTesting.TestArgs(t, &muxTesting.Args{
				Method:             http.MethodGet,
				Path:               testCase.path,
				Headers:            [][2]string{{"Accept-Encoding", testCase.acceptEncoding}},
				ExpectedStatusCode: http.StatusOK,
				ExpectedHeaders:    testCase.expectedHeaders,
				ExpectedBody:       []byte(testCase.expectedBody),
			}, server.URL)
		})
	}
}

// TestHttpHeadersAssetsVary checks that a cache is told the body depends on Accept-Encoding, which the
// mux merges with what it varies on itself.
func TestHttpHeadersAssetsVary(t *testing.T) {
	t.Parallel()

	endpoints, err := newHttpHeadersAssetEndpoints(fakeHttpHeadersAssets())
	if err != nil {
		t.Fatalf("new http headers asset endpoints: %v", err)
	}

	server := httptest.NewServer(altshiftMux.New(endpoints...))
	t.Cleanup(server.Close)

	for _, asset := range httpHeadersAssetList {
		t.Run(asset.name, func(t *testing.T) {
			t.Parallel()

			request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL+httpHeadersAssetsPath+asset.name, nil)
			if err != nil {
				t.Fatalf("new request: %v", err)
			}
			request.Header.Set("Accept-Encoding", "br")

			response, err := server.Client().Do(request)
			if err != nil {
				t.Fatalf("client do: %v", err)
			}
			_ = response.Body.Close()

			if vary := response.Header.Get("Vary"); !strings.Contains(vary, "Accept-Encoding") {
				t.Errorf("Vary = %q, want it to hold Accept-Encoding", vary)
			}
		})
	}
}

func TestNewHttpHeadersAssetEndpointsErrors(t *testing.T) {
	t.Parallel()

	empty := fakeHttpHeadersAssets()
	empty[httpHeadersAssetsDirectory+"/wasm_exec.js"] = &fstest.MapFile{}

	testCases := []struct {
		name   string
		assets fstest.MapFS
	}{
		{name: "no module", assets: fakeHttpHeadersAssets("http_headers.wasm")},
		{name: "no brotli encoding of the worker", assets: fakeHttpHeadersAssets("worker.js.br")},
		{name: "no gzip encoding of the module", assets: fakeHttpHeadersAssets("http_headers.wasm.gz")},
		{name: "an empty file", assets: empty},
		{name: "no assets", assets: nil},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			var err error
			if testCase.assets == nil {
				_, err = newHttpHeadersAssetEndpoints(nil)
			} else {
				_, err = newHttpHeadersAssetEndpoints(testCase.assets)
			}

			if err == nil {
				t.Error("expected an error, got nil")
			}
		})
	}
}

// TestEmbeddedHttpHeadersAssets checks the build the binary carries, which the Makefile makes: a
// build missing an encoding would otherwise only fail when the service starts.
func TestEmbeddedHttpHeadersAssets(t *testing.T) {
	t.Parallel()

	endpoints, err := newHttpHeadersAssetEndpoints(httpHeadersAssets)
	if err != nil {
		t.Fatalf("new http headers asset endpoints: %v", err)
	}

	if len(endpoints) != len(httpHeadersAssetList) {
		t.Errorf("%d endpoints, want %d", len(endpoints), len(httpHeadersAssetList))
	}
}
