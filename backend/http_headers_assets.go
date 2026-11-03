package main

import (
	"embed"
	"fmt"
	"io/fs"
	"net/http"
	"slices"
	"time"

	altshiftErrors "github.com/altshiftab/utils_go/pkg/errors"
	"github.com/altshiftab/utils_go/pkg/errors/types/empty_error"
	"github.com/altshiftab/utils_go/pkg/errors/types/nil_error"
	endpointPkg "github.com/altshiftab/utils_go/pkg/http/mux/types/endpoint"
	"github.com/altshiftab/utils_go/pkg/http/mux/types/endpoint/static_content"
	"github.com/altshiftab/utils_go/pkg/http/mux/types/response"
	muxUtils "github.com/altshiftab/utils_go/pkg/http/mux/utils"
	altshiftHttpUtils "github.com/altshiftab/utils_go/pkg/http/utils"
)

// The /http-headers page analyses what is pasted into it in the browser, so that cookies, session
// ids and internal host names never leave it: the analysis is altshift_web_security compiled to
// WebAssembly, run in a worker. The worker, the Go runtime glue it loads and the module are served
// here rather than as static content from frontend/dist: the static-content generator has no
// mapping for .wasm, and the page must know the worker's URL, which a content-hashed name would hide.
// The Makefile builds them into http_headers_assets, each beside its brotli and gzip encodings.
//
//go:embed http_headers_assets
var httpHeadersAssets embed.FS

const (
	httpHeadersAssetsDirectory = "http_headers_assets"
	// httpHeadersAssetsPath is where the worker is served from, and so where the names it loads
	// beside it resolve to.
	httpHeadersAssetsPath = "/analysis/http_headers/"

	javascriptContentType = "text/javascript"

	acceptEncodingHeaderName = "Accept-Encoding"

	// The names are fixed, so a browser revalidates rather than keeps a stale copy.
	httpHeadersAssetsCacheControl = "no-cache"

	// A worker takes its policy from its own script's response, not the page's. It loads the glue
	// beside it, fetches the module and compiles it, and needs nothing else; compiling is what the
	// page's own policy does not allow, which is why the analysis runs here.
	httpHeadersWorkerContentSecurityPolicy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; " +
		"connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)

// precompressedEncodings are the encodings each asset is built beside, by their file extension. The
// module is megabytes, and compressing it at the best brotli quality takes seconds of the start of
// every instance, so it is done once, at build time.
var precompressedEncodings = []struct {
	contentEncoding string
	extension       string
}{
	{contentEncoding: "br", extension: ".br"},
	{contentEncoding: "gzip", extension: ".gz"},
}

type httpHeadersAsset struct {
	name        string
	contentType string
	headers     []*response.HeaderEntry
}

var httpHeadersAssetList = []*httpHeadersAsset{
	{
		name:        "worker.js",
		contentType: javascriptContentType,
		headers: []*response.HeaderEntry{
			// Both are document defaults, which the mux keeps from a response unless it is told to
			// overwrite them.
			{Name: "Content-Security-Policy", Value: httpHeadersWorkerContentSecurityPolicy, Overwrite: true},
			// A dedicated worker of a cross-origin isolated document must be isolated too, or it does
			// not start.
			{Name: "Cross-Origin-Embedder-Policy", Value: "require-corp", Overwrite: true},
		},
	},
	{name: "wasm_exec.js", contentType: javascriptContentType},
	// The type is what lets the worker compile the module as it streams in.
	{name: "http_headers.wasm", contentType: "application/wasm"},
}

// newHttpHeadersAssetEndpoints serves the analysis assets in assets, which holds them under
// http_headers_assets as the Makefile builds them.
func newHttpHeadersAssetEndpoints(assets fs.FS) ([]*endpointPkg.Endpoint, error) {
	if assets == nil {
		return nil, altshiftErrors.NewWithTrace(nil_error.New("assets"))
	}

	lastModified := time.Now().UTC().Format(http.TimeFormat)

	endpoints := make([]*endpointPkg.Endpoint, 0, len(httpHeadersAssetList))
	for _, asset := range httpHeadersAssetList {
		staticContent, err := makeHttpHeadersAssetContent(assets, asset, lastModified)
		if err != nil {
			return nil, fmt.Errorf("make http headers asset content: %w", err)
		}

		endpoints = append(endpoints, &endpointPkg.Endpoint{
			Path:          httpHeadersAssetsPath + asset.name,
			Method:        http.MethodGet,
			Public:        true,
			StaticContent: staticContent,
		})
	}

	return endpoints, nil
}

func readHttpHeadersAsset(assets fs.FS, name string) ([]byte, error) {
	data, err := fs.ReadFile(assets, httpHeadersAssetsDirectory+"/"+name)
	if err != nil {
		return nil, altshiftErrors.NewWithTrace(fmt.Errorf("fs read file: %w", err), name)
	}
	if len(data) == 0 {
		return nil, altshiftErrors.NewWithTrace(empty_error.NewWithInstance("http headers asset", name))
	}

	return data, nil
}

func makeHttpHeadersAssetContent(
	assets fs.FS,
	asset *httpHeadersAsset,
	lastModified string,
) (*static_content.StaticContent, error) {
	if asset == nil {
		return nil, altshiftErrors.NewWithTrace(nil_error.New("http headers asset"))
	}

	data, err := readHttpHeadersAsset(assets, asset.name)
	if err != nil {
		return nil, err
	}

	etag := altshiftHttpUtils.MakeStrongEtag(data)

	headers := muxUtils.MakeStaticContentHeaders(asset.contentType, httpHeadersAssetsCacheControl, etag, lastModified)
	headers = append(headers, asset.headers...)
	headers = append(headers, &response.HeaderEntry{Name: "Vary", Value: acceptEncodingHeaderName})

	contentEncodingToData := make(map[string]*static_content.StaticContentData, len(precompressedEncodings))
	for _, encoding := range precompressedEncodings {
		encodedData, err := readHttpHeadersAsset(assets, asset.name+encoding.extension)
		if err != nil {
			return nil, err
		}

		// The bytes alone: the mux answers with the identity's headers whatever the encoding, adding
		// Content-Encoding, and revalidates against the identity's ETag.
		contentEncodingToData[encoding.contentEncoding] = &static_content.StaticContentData{Data: encodedData}
	}

	return &static_content.StaticContent{
		StaticContentData: static_content.StaticContentData{
			Data:         data,
			Etag:         etag,
			LastModified: lastModified,
			// Clipped, because the mux appends each response's own headers to this slice: with spare
			// capacity, two requests would write into the same backing array.
			Headers: slices.Clip(headers),
		},
		ContentEncodingToData: contentEncodingToData,
	}, nil
}
