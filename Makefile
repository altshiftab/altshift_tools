.DEFAULT_GOAL := all

.PHONY: all update frontend-update backend-update build frontend-check frontend-build backend-build publish backend-publish backend-publish-build backend-deploy

# The pseudo-version corresponds to the typescript/v7.0.2 release tag (2bd066d87f5b).
TSGO := github.com/microsoft/typescript-go/cmd/tsgo@v0.0.0-20260708042240-2bd066d87f5b

backend-build:
	@echo "[backend] Building..."
	cd backend && GOEXPERIMENT=jsonv2 go generate && GOOS=linux GOEXPERIMENT=jsonv2 go build -a -ldflags="-s -w -buildid=" -installsuffix cgo -o ../service

frontend-check:
	@echo "[frontend] Type checking..."
	cd frontend && go run $(TSGO) --noEmit -p tsconfig.json

frontend-build: frontend-check
	@echo "[frontend] Building..."
	cd frontend && GOEXPERIMENT=jsonv2 go run github.com/altshiftab/web_build/cmd/web_build@v0.0.4 -splitting

build: frontend-build backend-build

backend-update:
	@echo "[backend] Updating..."
	cd backend && gm

frontend-update:
	@echo "[frontend] Updating..."
	cd frontend && ncu --upgrade && npm update

update: frontend-update backend-update

all: update build

backend-publish-build:
	@echo "[backend] Building for publish..."
	cd backend && podman build . --tag altshift-tools

backend-publish: build backend-publish-build
	@echo "[backend] Publishing..."
	podman tag altshift-tools europe-north2-docker.pkg.dev/altshift-main/images/altshift-tools:latest \
		&& podman push europe-north2-docker.pkg.dev/altshift-main/images/altshift-tools:latest

publish: backend-publish

backend-deploy: backend-publish
	@echo "[backend] Deploying to Cloud Run..."
	gcloud run deploy altshift-tools \
		--image=europe-north2-docker.pkg.dev/altshift-main/images/altshift-tools:latest \
		--region=europe-north2 \
		--project=altshift-main \
		--platform=managed \
		--quiet
