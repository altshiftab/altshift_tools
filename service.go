package main

import (
	"context"
	"fmt"
	motmedelEnv "github.com/Motmedel/utils_go/pkg/env"
	motmedelErrors "github.com/Motmedel/utils_go/pkg/errors"
	motmedelMux "github.com/Motmedel/utils_go/pkg/http/mux"
	"github.com/Motmedel/utils_go/pkg/http/mux/types/response_error"
	"github.com/Motmedel/utils_go/pkg/http/problem_detail"
	motmedelHttpTypes "github.com/Motmedel/utils_go/pkg/http/types"
	altshiftGcpUtilsHttp "github.com/altshiftab/gcp_utils/pkg/http"
	altshiftGcpUtilsLog "github.com/altshiftab/gcp_utils/pkg/log"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
	"log/slog"
	"net/http"
	"net/url"
)

const (
	baseDomain = "altshift.se"
	domain     = "str.tools.altshift.se"
)

func makeMux() (*motmedelMux.Mux, error) {
	baseUrlString := fmt.Sprintf("https://%s", domain)
	baseUrl, err := url.Parse(baseUrlString)
	if err != nil {
		return nil, motmedelErrors.NewWithTrace(fmt.Errorf("url parse: %w", err), baseUrlString)
	}

	mux := altshiftGcpUtilsHttp.MakeMux(staticContentEndpointSpecifications, nil)

	documentEndpointSpecifications := mux.GetDocumentEndpointSpecifications()

	if err := altshiftGcpUtilsHttp.PatchCrawlable(mux, baseUrl, documentEndpointSpecifications); err != nil {
		return nil, motmedelErrors.New(
			fmt.Errorf("patch crawlable: %w", err),
			mux, baseUrl, documentEndpointSpecifications,
		)
	}

	if err := altshiftGcpUtilsHttp.PatchErrorReporting(mux, baseUrl); err != nil {
		return nil, motmedelErrors.New(fmt.Errorf("patch error reporting: %w", err), mux, baseUrl)
	}

	if err := altshiftGcpUtilsHttp.PatchStrictTransportSecurity(mux); err != nil {
		return nil, motmedelErrors.New(fmt.Errorf("patch strict transport security: %w", err), mux)
	}

	baseDomainUrlString := fmt.Sprintf("https://www.%s", baseDomain)
	baseDomainUrl, err := url.Parse(baseDomainUrlString)
	if err != nil {
		return nil, motmedelErrors.NewWithTrace(
			fmt.Errorf("url parse (base domain): %w", err),
			baseDomainUrlString,
		)
	}

	securityTxtUrl := baseDomainUrl.JoinPath("/.well-known/security.txt")
	if err := altshiftGcpUtilsHttp.PatchOtherDomainSecurityTxt(mux, securityTxtUrl); err != nil {
		return nil, motmedelErrors.New(
			fmt.Errorf("patch other domain security txt: %w", err),
			mux, securityTxtUrl,
		)
	}

	return mux, nil
}

func main() {
	logger := altshiftGcpUtilsLog.DefaultFatal(context.Background())
	slog.SetDefault(logger.Logger)

	port := motmedelEnv.GetEnvWithDefault("PORT", "8080")

	mux, err := makeMux()
	if err != nil {
		logger.FatalWithExitingMessage("An error occurred when making the mux.", fmt.Errorf("make mux: %w", err))
	}

	mux.ProblemDetailConverter = response_error.ProblemDetailConverterFunction(
		func(detail *problem_detail.ProblemDetail, negotiation *motmedelHttpTypes.ContentNegotiation) ([]byte, string, error) {
			data, contentType, err := response_error.ConvertProblemDetail(detail, negotiation)
			if contentType == "application/problem+xml" {
				contentType = "application/xml"
			}
			return data, contentType, err
		},
	)

	vhostMux := &motmedelMux.VhostMux{
		HostToSpecification: map[string]*motmedelMux.VhostMuxSpecification{domain: {Mux: mux}},
	}

	httpServer := &http.Server{Addr: fmt.Sprintf(":%s", port), Handler: h2c.NewHandler(vhostMux, &http2.Server{})}
	if err := httpServer.ListenAndServe(); err != nil {
		logger.FatalWithExitingMessage(
			"An error occurred when listening and serving.",
			motmedelErrors.NewWithTrace(fmt.Errorf("http server listen and serve: %w", err), httpServer),
		)
	}
}
