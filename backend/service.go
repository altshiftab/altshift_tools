package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/url"

	motmedelEnv "github.com/Motmedel/utils_go/pkg/env"
	motmedelErrors "github.com/Motmedel/utils_go/pkg/errors"
	"github.com/Motmedel/utils_go/pkg/errors/types/empty_error"
	"github.com/Motmedel/utils_go/pkg/errors/types/nil_error"
	motmedelMux "github.com/Motmedel/utils_go/pkg/http/mux"
	contentSecurityPolicy "github.com/Motmedel/utils_go/pkg/http/types/content_security_policy"
	contentSecurityPolicyUtils "github.com/Motmedel/utils_go/pkg/http/utils/content_security_policy"
	gcpUtilsHttp "github.com/altshiftab/gcp_utils/pkg/http"
	"github.com/altshiftab/gcp_utils/pkg/http/types/service"
	"github.com/altshiftab/gcp_utils/pkg/http/types/service/service_config"
	gcpUtilsLogger "github.com/altshiftab/gcp_utils/pkg/types/logger"
)

// The frontend is a Lit SPA bundled with webpack; Lit registers a "lit-html" Trusted Types
// policy and webpack's chunk loader registers a "webpack" one. Both must be allow-listed by
// the require-trusted-types-for CSP, otherwise createPolicy is rejected and the page fails to
// load. These names match the hard-coded defaults in @altshiftab/webpack_configuration and Lit.
//
// The /fingerprint page additionally installs a pass-through "default" policy so the bundled
// fingerprinting libraries — which assign to Trusted Types sinks with plain strings
// (FingerprintJS sets innerHTML; the CreepJS-style probe constructs a Worker) — can run under
// the enforced CSP. Only that module installs the policy, so the other routes keep full
// Trusted Types enforcement even though the name is allow-listed globally.
const (
	litHtmlTrustedTypesPolicy = "lit-html"
	webpackTrustedTypesPolicy = "webpack"
	defaultTrustedTypesPolicy = "default"
)

var spaRoutes = []string{"/str", "/fingerprint", "/privacy-policy"}

func main() {
	logger := gcpUtilsLogger.New()
	slog.SetDefault(logger.Logger)

	domain := motmedelEnv.GetEnvWithDefault("DOMAIN", "localhost")
	port := motmedelEnv.GetEnvWithDefault("PORT", "8080")

	httpService, err := service.New(
		domain,
		port,
		service_config.WithStaticContentEndpoints(staticContentEndpoints),
		service_config.WithPublic(true),
	)
	if err != nil {
		logger.FatalWithExitingMessage("An error occurred when creating the http service.", err)
	}
	if httpService == nil {
		logger.FatalWithExitingMessage("Nil http service.", nil)
		return
	}

	mux := httpService.Mux
	if mux == nil {
		logger.FatalWithExitingMessage("Nil mux.", nil)
	}

	if err := patchFingerprintContentSecurityPolicy(mux); err != nil {
		logger.FatalWithExitingMessage(
			"An error occurred when patching the fingerprint content security policy.",
			motmedelErrors.New(fmt.Errorf("patch fingerprint content security policy: %w", err), mux),
		)
	}

	if err := gcpUtilsHttp.PatchTrustedTypes(
		mux,
		litHtmlTrustedTypesPolicy, webpackTrustedTypesPolicy, defaultTrustedTypesPolicy,
	); err != nil {
		logger.FatalWithExitingMessage(
			"An error occurred when patching trusted types.",
			motmedelErrors.NewWithTrace(
				fmt.Errorf("patch trusted types: %w", err),
				mux, litHtmlTrustedTypesPolicy, webpackTrustedTypesPolicy, defaultTrustedTypesPolicy,
			),
		)
	}

	indexEndpoint := mux.Get("/", http.MethodGet)
	if indexEndpoint == nil {
		logger.FatalWithExitingMessage("Nil index endpoint.", nil)
	}

	if err := mux.DuplicateEndpointSpecification(indexEndpoint, spaRoutes...); err != nil {
		logger.FatalWithExitingMessage(
			"An error occurred when duplicating the index endpoint specification.",
			motmedelErrors.New(
				fmt.Errorf("mux duplicate endpoint specification: %w", err),
				indexEndpoint, spaRoutes,
			),
		)
	}

	// The document is served only at the tool routes; there is no root page.
	mux.Delete(indexEndpoint)

	// service.New builds the sitemap before the routes above are swapped in, so
	// it would only list the now-deleted "/". Regenerate it from the current
	// document endpoints; mux.Add upserts, so sitemap.xml and robots.txt are
	// replaced.
	scheme := "https"
	if domain == "localhost" {
		scheme = "http"
	}
	baseUrl := &url.URL{Scheme: scheme, Host: domain}
	if err := gcpUtilsHttp.PatchCrawlable(mux, baseUrl, mux.GetDocumentEndpointSpecifications()); err != nil {
		logger.FatalWithExitingMessage(
			"An error occurred when patching crawlable.",
			motmedelErrors.NewWithTrace(fmt.Errorf("patch crawlable: %w", err), mux, baseUrl),
		)
	}

	httpServer := httpService.Server
	if httpServer == nil {
		logger.FatalWithExitingMessage("Nil http server", nil)
	}

	if err := httpServer.ListenAndServe(); err != nil {
		logger.FatalWithExitingMessage(
			"An error occurred when listening and serving.",
			motmedelErrors.NewWithTrace(fmt.Errorf("http server listen and serve: %w", err), httpServer),
		)
	}
}

// patchFingerprintContentSecurityPolicy adds "self" and "blob:" to the shared document CSP's
// worker-src: the /fingerprint tool's CreepJS-style probe runs a Worker from a blob: URL, which
// "default-src 'self'" would otherwise reject.
//
// Trusted Types stays enforced; see the PatchTrustedTypes call, which additionally allow-lists
// the "default" policy the fingerprint page installs.
func patchFingerprintContentSecurityPolicy(mux *motmedelMux.Mux) error {
	if mux == nil {
		return motmedelErrors.NewWithTrace(nil_error.New("mux"))
	}

	defaultDocumentHeaders := mux.DefaultDocumentHeaders
	if defaultDocumentHeaders == nil {
		return motmedelErrors.NewWithTrace(nil_error.New("default document headers"))
	}

	contentSecurityPolicyString := defaultDocumentHeaders[gcpUtilsHttp.ContentSecurityPolicyHeader]
	if contentSecurityPolicyString == "" {
		return motmedelErrors.NewWithTrace(empty_error.New("content security policy"))
	}

	csp, err := contentSecurityPolicy.Parse([]byte(contentSecurityPolicyString))
	if err != nil {
		return motmedelErrors.New(
			fmt.Errorf("parse content security policy: %w", err),
			contentSecurityPolicyString,
		)
	}
	if csp == nil {
		return motmedelErrors.NewWithTrace(nil_error.New("content security policy"))
	}

	contentSecurityPolicyUtils.PatchCspSourceDirective[contentSecurityPolicy.WorkerSrcDirective](
		csp,
		&contentSecurityPolicy.KeywordSource{Keyword: "self"},
		&contentSecurityPolicy.SchemeSource{Scheme: "blob"},
	)

	defaultDocumentHeaders[gcpUtilsHttp.ContentSecurityPolicyHeader] = csp.String()

	return nil
}
