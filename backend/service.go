package main

import (
	"fmt"
	"log/slog"

	motmedelEnv "github.com/Motmedel/utils_go/pkg/env"
	motmedelErrors "github.com/Motmedel/utils_go/pkg/errors"
	"github.com/altshiftab/gcp_utils/pkg/http/types/service"
	"github.com/altshiftab/gcp_utils/pkg/http/types/service/service_config"
	gcpUtilsLogger "github.com/altshiftab/gcp_utils/pkg/types/logger"
)

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
