package main

import (
	"fmt"
	"log/slog"
	"net/http"

	motmedelEnv "github.com/Motmedel/utils_go/pkg/env"
	motmedelErrors "github.com/Motmedel/utils_go/pkg/errors"
	"github.com/altshiftab/gcp_utils/pkg/http/types/service"
	"github.com/altshiftab/gcp_utils/pkg/http/types/service/service_config"
	gcpUtilsLogger "github.com/altshiftab/gcp_utils/pkg/types/logger"
)

var spaRoutes = []string{"/str", "/fingerprint"}

func main() {
	logger := gcpUtilsLogger.New()
	slog.SetDefault(logger.Logger)

	domain := motmedelEnv.GetEnvWithDefault("DOMAIN", "localhost")
	port := motmedelEnv.GetEnvWithDefault("PORT", "8080")

	httpService, err := service.New(domain, port, service_config.WithStaticContentEndpoints(staticContentEndpoints))
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
