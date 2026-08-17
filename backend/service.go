package main

import (
	"fmt"
	"log/slog"
	"net/http"

	altshiftEnv "github.com/altshiftab/utils_go/pkg/env"
	altshiftErrors "github.com/altshiftab/utils_go/pkg/errors"
	"github.com/altshiftab/utils_go/pkg/errors/types/empty_error"
	"github.com/altshiftab/utils_go/pkg/errors/types/nil_error"
	altshiftMux "github.com/altshiftab/utils_go/pkg/http/mux"
	endpointPkg "github.com/altshiftab/utils_go/pkg/http/mux/types/endpoint"
	altshiftService "github.com/altshiftab/utils_go/pkg/http/service"
	"github.com/altshiftab/utils_go/pkg/http/service/service_config"
	altshiftHttpTypes "github.com/altshiftab/utils_go/pkg/http/types"
	contentSecurityPolicy "github.com/altshiftab/utils_go/pkg/http/types/content_security_policy"
	contentSecurityPolicyUtils "github.com/altshiftab/utils_go/pkg/http/utils/content_security_policy"
	altshiftHttpLogger "github.com/altshiftab/utils_go/pkg/log/http_logger"
	"github.com/altshiftab/utils_go/pkg/log/http_logger/http_logger_config"
)

const contentSecurityPolicyHeaderName = "Content-Security-Policy"

// The frontend is a Lit SPA. Lit registers a "lit-html" Trusted Types policy, which the
// require-trusted-types-for policy must allow, or createPolicy is rejected and the page fails to
// load.
//
// The /fingerprint page additionally installs a pass-through "default" policy so the bundled
// fingerprinting libraries -- which assign to Trusted Types sinks with plain strings (FingerprintJS
// sets innerHTML; the CreepJS-style probe constructs a Worker) -- can run under the enforced policy.
// Only that module installs it, so the other routes keep full Trusted Types enforcement even though
// the name is allowed everywhere.
const (
	litHtmlTrustedTypesPolicy = "lit-html"
	defaultTrustedTypesPolicy = "default"
)

// spaRoutes are the routes the frontend routes on its own. The document is served at each of them
// and at no root: there is no page at "/".
var spaRoutes = []string{"/str", "/fingerprint", "/privacy-policy"}

// toolEndpoints are the endpoints the service serves: what is built, with the document that would
// be served at "/" served at the tool routes instead.
func toolEndpoints(endpoints []*endpointPkg.Endpoint) ([]*endpointPkg.Endpoint, error) {
	var indexEndpoint *endpointPkg.Endpoint

	toolEndpoints := make([]*endpointPkg.Endpoint, 0, len(endpoints)+len(spaRoutes))
	for _, endpoint := range endpoints {
		if endpoint == nil {
			continue
		}

		if endpoint.Path == "/" && endpoint.Method == http.MethodGet {
			indexEndpoint = endpoint
			continue
		}

		toolEndpoints = append(toolEndpoints, endpoint)
	}

	if indexEndpoint == nil {
		return nil, altshiftErrors.NewWithTrace(nil_error.NewWithInstance("endpoint", "index"))
	}

	return append(toolEndpoints, endpointPkg.Duplicate(indexEndpoint, spaRoutes...)...), nil
}

func main() {
	logger := altshiftHttpLogger.New(http_logger_config.WithGcp(true))
	slog.SetDefault(logger.Logger)

	domain := altshiftEnv.GetEnvWithDefault("DOMAIN", "localhost")
	port := altshiftEnv.GetEnvWithDefault("PORT", "8080")

	endpoints, err := toolEndpoints(staticContentEndpoints)
	if err != nil {
		logger.FatalWithExitingMessage(
			"An error occurred when making the tool endpoints.",
			altshiftErrors.New(fmt.Errorf("tool endpoints: %w", err)),
		)
	}

	httpService, err := altshiftService.New(
		service_config.WithHost(domain),
		service_config.WithAddress(fmt.Sprintf(":%s", port)),
		service_config.WithProfile(service_config.ProfilePublicWeb),
		// The frontend is built with code splitting, so a document names its chunks in an import map
		// and vouches for them there rather than on a script element. Safari 26 loses what the map
		// carries and blocks every chunk an entry imports, leaving the page blank; reporting a
		// violation says as much without taking the page down with it. Enforcement can come back
		// once Safari 26 is out of the traffic.
		service_config.WithIntegrityPolicyEnforced(false),
		// The endpoints are given before the service is made, the sitemap being made of what it is
		// given: it lists the tool routes, and no root that is not served.
		service_config.WithEndpoints(endpoints...),
		service_config.WithTrustedTypes(litHtmlTrustedTypesPolicy, defaultTrustedTypesPolicy),
		// The load balancer speaks prior-knowledge unencrypted HTTP/2 to the backend, which the
		// standard library serves alongside HTTP/1.
		service_config.WithUnencryptedHttp2(true),
		// The languages a vulnerability is preferably reported in; the rest of what the security.txt
		// says, and which of its forms is served, follows from the domain.
		service_config.WithSecurityTxtContent(
			&altshiftHttpTypes.SecurityTxt{PreferredLanguages: []string{"sv", "en"}},
		),
	)
	if err != nil {
		logger.FatalWithExitingMessage(
			"An error occurred when creating the http service.",
			altshiftErrors.New(fmt.Errorf("service new: %w", err), domain, port),
		)
	}
	if httpService == nil {
		logger.FatalWithExitingMessage("Nil http service.", nil)
		return
	}

	if err := patchFingerprintContentSecurityPolicy(httpService.Mux); err != nil {
		logger.FatalWithExitingMessage(
			"An error occurred when patching the fingerprint content security policy.",
			altshiftErrors.New(fmt.Errorf("patch fingerprint content security policy: %w", err)),
		)
	}

	// Serving stops when the process is asked to, letting the requests being handled finish: an
	// instance is replaced whenever a revision is, and a request killed midway leaves whatever it
	// was doing half done.
	if err := httpService.Serve(); err != nil {
		logger.FatalWithExitingMessage(
			"An error occurred when serving.",
			altshiftErrors.New(fmt.Errorf("service serve: %w", err)),
		)
	}
}

// patchFingerprintContentSecurityPolicy adds "self" and "blob:" to the shared document policy's
// worker-src: the /fingerprint tool's CreepJS-style probe runs a Worker from a blob: URL, which
// "default-src 'self'" would otherwise reject.
//
// Trusted Types stays enforced; see the trusted types the service is made with, which additionally
// allow the "default" policy the fingerprint page installs.
func patchFingerprintContentSecurityPolicy(mux *altshiftMux.Mux) error {
	if mux == nil {
		return altshiftErrors.NewWithTrace(nil_error.New("mux"))
	}

	defaultDocumentHeaders := mux.DefaultDocumentHeaders
	if defaultDocumentHeaders == nil {
		return altshiftErrors.NewWithTrace(nil_error.New("default document headers"))
	}

	contentSecurityPolicyString := defaultDocumentHeaders[contentSecurityPolicyHeaderName]
	if contentSecurityPolicyString == "" {
		return altshiftErrors.NewWithTrace(empty_error.New("content security policy"))
	}

	csp, err := contentSecurityPolicy.Parse([]byte(contentSecurityPolicyString))
	if err != nil {
		return altshiftErrors.New(
			fmt.Errorf("parse content security policy: %w", err),
			contentSecurityPolicyString,
		)
	}
	if csp == nil {
		return altshiftErrors.NewWithTrace(nil_error.New("content security policy"))
	}

	contentSecurityPolicyUtils.PatchCspSourceDirective[contentSecurityPolicy.WorkerSrcDirective](
		csp,
		&contentSecurityPolicy.KeywordSource{Keyword: "self"},
		&contentSecurityPolicy.SchemeSource{Scheme: "blob"},
	)

	defaultDocumentHeaders[contentSecurityPolicyHeaderName] = csp.String()

	return nil
}
